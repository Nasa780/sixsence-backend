-- =============================================================================
-- 0021 : correction d'un match terminé par l'équipe (mauvais clic, erreur de déclaration)
-- =============================================================================
-- L'équipe (admin, staff, arbitre) peut inverser le vainqueur ou annuler un match déjà
-- validé : les points, victoires, défaites et l'XP du match sont rendus, puis le bon
-- résultat est appliqué (barème du moment). Chaque correction est enregistrée.

alter table public.cod_matches add column if not exists corrected_at      timestamptz;
alter table public.cod_matches add column if not exists corrected_by      uuid references public.users (id) on delete set null;
alter table public.cod_matches add column if not exists correction_reason text;
alter table public.cod_matches add column if not exists correction_action text check (correction_action in ('swap', 'cancel'));

create table if not exists public.cod_match_corrections (
  id              bigint generated always as identity primary key,
  match_id        uuid not null references public.cod_matches (id) on delete cascade,
  staff_id        uuid references public.users (id) on delete set null,
  action          text not null check (action in ('swap', 'cancel')),
  previous_winner text not null,
  new_winner      text,
  reason          text not null,
  points_before   jsonb,
  points_after    jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists cod_match_corrections_match_idx on public.cod_match_corrections (match_id);

alter table public.cod_match_corrections enable row level security;

-- Corrige un match terminé.
--   p_action    'swap' (inverser le vainqueur) ou 'cancel' (annuler le match)
--   p_max_hours délai après la validation (null : sans limite, réservé à l'admin côté backend)
-- Les variations du match (points_changes) sont retirées : gagnants -points, -1 victoire,
-- -500 XP, série -1 ; perdants : points rendus, -1 défaite. Puis, pour 'swap', le match est
-- revalidé avec l'autre vainqueur (cod_finalize_match, barème du moment).
create or replace function public.cod_correct_match(p_match uuid, p_action text, p_staff uuid, p_reason text, p_max_hours integer)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  k_win_xp  constant integer := 500;
  m         public.cod_matches;
  v_winners uuid[];
  v_losers  uuid[];
  v_changes jsonb;
  v_new     text;
  v_reason  text := trim(coalesce(p_reason, ''));
  v_id      bigint;
begin
  if p_action is null or p_action not in ('swap', 'cancel') then
    raise exception 'INVALID_ACTION';
  end if;
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'INVALID_REASON';
  end if;

  perform pg_advisory_xact_lock(hashtext('sixsence_cod_matchmaking'));

  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status <> 'completed' or m.winner is null then
    raise exception 'MATCH_NOT_COMPLETED';
  end if;
  if p_max_hours is not null and m.completed_at < now() - make_interval(hours => p_max_hours) then
    raise exception 'CORRECTION_TOO_LATE';
  end if;

  if m.winner = 'A' then
    v_winners := m.team_a;
    v_losers  := m.team_b;
    v_new     := 'B';
  else
    v_winners := m.team_b;
    v_losers  := m.team_a;
    v_new     := 'A';
  end if;
  v_changes := coalesce(m.points_changes, '{}'::jsonb);

  -- Retrait des effets du match.
  update public.cod_profiles p
     set points     = greatest(0, p.points - coalesce((v_changes ->> p.user_id::text)::integer, 0)),
         wins       = greatest(0, p.wins - 1),
         xp         = greatest(0, p.xp - k_win_xp),
         win_streak = greatest(0, p.win_streak - 1)
   where p.user_id = any (v_winners);

  update public.cod_profiles p
     set points = greatest(0, p.points - coalesce((v_changes ->> p.user_id::text)::integer, 0)),
         losses = greatest(0, p.losses - 1)
   where p.user_id = any (v_losers);

  insert into public.cod_match_corrections (match_id, staff_id, action, previous_winner, new_winner, reason, points_before)
  values (p_match, p_staff, p_action, m.winner, case when p_action = 'swap' then v_new end, v_reason, v_changes)
  returning id into v_id;

  if p_action = 'cancel' then
    update public.cod_matches
       set status = 'cancelled', cancel_reason = 'staff', winner = null, points_changes = '{}'::jsonb
     where id = p_match;
  else
    -- Revalidation avec l'autre vainqueur (cod_finalize_match refuse un match terminé).
    update public.cod_matches set status = 'disputed', winner = null, points_changes = '{}'::jsonb where id = p_match;
    perform public.cod_finalize_match(p_match, v_new);
  end if;

  update public.cod_matches
     set corrected_at = now(), corrected_by = p_staff, correction_reason = v_reason, correction_action = p_action,
         discord_done = false
   where id = p_match
  returning * into m;

  update public.cod_match_corrections set points_after = m.points_changes where id = v_id;
  return m;
end;
$$;

revoke execute on function public.cod_correct_match(uuid, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.cod_correct_match(uuid, text, uuid, text, integer) to service_role;
