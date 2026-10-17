-- =============================================================================
-- 0029 : correction d'un match d'équipe terminé, rôle Discord des équipes
-- =============================================================================
--   * team_match_correct : un arbitre (48 h) ou un admin (sans limite) remplace les scores d'un
--     match terminé (le vainqueur peut changer) ou l'annule ; points et bilan des deux équipes
--     recalculés (mêmes enjeux) ; historique dans team_match_corrections ; pas pour les matchs de tournoi ;
--   * teams.discord_role_id : rôle Discord « [TAG] Nom » de l'équipe.

alter table public.teams add column if not exists discord_role_id text;

alter table public.team_matches add column if not exists corrected_at timestamptz;
alter table public.team_matches add column if not exists corrected_by uuid references public.users (id);
alter table public.team_matches add column if not exists correction_reason text;

create table if not exists public.team_match_corrections (
  id              bigint generated always as identity primary key,
  match_id        uuid not null references public.team_matches (id) on delete cascade,
  staff_id        uuid not null references public.users (id),
  previous_scores jsonb not null,
  previous_winner text,
  new_scores      jsonb,
  new_winner      text,
  reason          text not null,
  created_at      timestamptz not null default now()
);
alter table public.team_match_corrections enable row level security;

create or replace function public.team_match_correct(p_match uuid, p_scores jsonb, p_winner text, p_staff uuid, p_reason text, p_max_hours integer)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m          public.team_matches;
  v_reason   text := trim(coalesce(p_reason, ''));
  v_old_gain integer;
  v_gain     integer;
  v_winner   uuid;
  v_loser    uuid;
begin
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'INVALID_REASON';
  end if;
  if p_scores is not null and (p_winner is null or p_winner not in ('A', 'B')) then
    raise exception 'INVALID_WINNER';
  end if;

  select * into m from public.team_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status <> 'completed' or m.winner is null then
    raise exception 'MATCH_NOT_COMPLETED';
  end if;
  if m.tournament_id is not null then
    raise exception 'TOURNAMENT_MATCH';
  end if;
  if p_max_hours is not null and m.completed_at < now() - make_interval(hours => p_max_hours) then
    raise exception 'CORRECTION_TOO_LATE';
  end if;

  -- Effets de l'ancien résultat retirés.
  v_old_gain := coalesce((m.points_changes ->> m.winner)::integer, 0);
  v_winner := case when m.winner = 'A' then m.team_a else m.team_b end;
  v_loser  := case when m.winner = 'A' then m.team_b else m.team_a end;
  update public.teams set points = greatest(0, points - v_old_gain), wins = greatest(0, wins - 1) where id = v_winner;
  update public.teams set points = points + v_old_gain, losses = greatest(0, losses - 1) where id = v_loser;

  insert into public.team_match_corrections (match_id, staff_id, previous_scores, previous_winner, new_scores, new_winner, reason)
  values (p_match, p_staff, m.scores, m.winner, p_scores, p_winner, v_reason);

  if p_scores is null then
    update public.team_matches
       set status = 'cancelled', cancel_reason = 'staff', winner = null, points_changes = '{}'::jsonb
     where id = p_match;
  else
    v_gain := (m.stakes -> p_winner ->> 'win')::integer;
    v_winner := case when p_winner = 'A' then m.team_a else m.team_b end;
    v_loser  := case when p_winner = 'A' then m.team_b else m.team_a end;
    update public.teams set points = points + v_gain, wins = wins + 1 where id = v_winner;
    update public.teams set points = greatest(0, points - v_gain), losses = losses + 1 where id = v_loser;
    update public.team_matches
       set scores = p_scores, winner = p_winner,
           points_changes = jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_gain)
     where id = p_match;
  end if;

  update public.team_matches
     set corrected_at = now(), corrected_by = p_staff, correction_reason = v_reason, discord_done = false, updated_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

revoke execute on function public.team_match_correct(uuid, jsonb, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.team_match_correct(uuid, jsonb, text, uuid, text, integer) to service_role;
