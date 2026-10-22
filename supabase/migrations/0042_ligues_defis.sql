-- =============================================================================
-- 0042 : ligues de Division, défis directs (scrims)
-- =============================================================================
--   * teams.league : 'elite' | 'ligue1' | 'ligue2' (null tant que les ligues ne sont pas activées, à partir
--     de 16 équipes) ; team_season_results.league : ligue de l'équipe à la clôture ;
--   * team_challenges : défi d'un Leader à une autre équipe (amical sans points, ou classé), maintenant ou
--     à une heure fixée ; team_matches.friendly / challenge_id ;
--   * team_match_create_direct : match entre deux équipes données (défi accepté) ;
--   * team_match_finalize : un match amical ne change ni les points ni le bilan des équipes (XP gardée).

alter table public.teams add column if not exists league text check (league in ('elite', 'ligue1', 'ligue2'));
alter table public.team_season_results add column if not exists league text;

alter table public.team_matches add column if not exists friendly boolean not null default false;

create table if not exists public.team_challenges (
  id           uuid primary key default gen_random_uuid(),
  from_team    uuid not null references public.teams (id) on delete cascade,
  to_team      uuid not null references public.teams (id) on delete cascade,
  created_by   uuid not null references public.users (id),
  answered_by  uuid references public.users (id),
  friendly     boolean not null default true,
  roster_from  uuid[] not null,
  roster_to    uuid[],
  scheduled_at timestamptz,
  message      text check (message is null or char_length(message) <= 200),
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'played')),
  match_id     uuid references public.team_matches (id) on delete set null,
  created_at   timestamptz not null default now(),
  answered_at  timestamptz
);
create index if not exists team_challenges_to on public.team_challenges (to_team, status);
create index if not exists team_challenges_from on public.team_challenges (from_team, status);
alter table public.team_challenges enable row level security;
drop policy if exists "team_challenges: lecture publique" on public.team_challenges;
create policy "team_challenges: lecture publique" on public.team_challenges for select to anon, authenticated using (true);

alter table public.team_matches add column if not exists challenge_id uuid references public.team_challenges (id) on delete set null;

-- Match direct entre deux équipes (défi accepté) : aucune des deux ne doit avoir de match ouvert.
create or replace function public.team_match_create_direct(
  p_team_a uuid, p_team_b uuid, p_roster_a uuid[], p_roster_b uuid[], p_maps text[], p_mode text, p_friendly boolean, p_challenge uuid
)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  ta public.teams;
  tb public.teams;
  m  public.team_matches;
begin
  perform pg_advisory_xact_lock(hashtext('sixsence_team_matchmaking'));
  if exists (select 1 from public.team_matches x where x.status in ('in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed') and (x.team_a in (p_team_a, p_team_b) or x.team_b in (p_team_a, p_team_b))) then
    raise exception 'TEAM_BUSY';
  end if;
  select * into ta from public.teams where id = p_team_a and disbanded_at is null;
  select * into tb from public.teams where id = p_team_b and disbanded_at is null;
  if ta.id is null or tb.id is null then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  insert into public.team_matches (season_id, team_a, team_b, roster_a, roster_b, points_a, points_b, stakes, mode, maps, host_side, activity_at, friendly, challenge_id)
  values (
    (select id from public.seasons where is_active limit 1),
    ta.id, tb.id, p_roster_a, p_roster_b, ta.points, tb.points,
    case when p_friendly then '{"A": {"win": 0, "loss": 0}, "B": {"win": 0, "loss": 0}}'::jsonb else public.team_match_stakes(ta.points, tb.points) end,
    p_mode,
    (select jsonb_agg(jsonb_build_object('map', map, 'pick', 'random') order by ord) from unnest(p_maps) with ordinality as t(map, ord)),
    case when random() < 0.5 then 'A' else 'B' end,
    now(),
    p_friendly,
    p_challenge
  )
  returning * into m;
  delete from public.team_queue where team_id in (ta.id, tb.id);
  return m;
end;
$$;

-- Clôture : un match amical ne touche ni aux points ni au bilan des équipes.
create or replace function public.team_match_finalize(p_match uuid, p_scores jsonb, p_winner text, p_resolved_by uuid, p_forfeit boolean default false)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m      public.team_matches;
  v_gain integer := 0;
  v_loss integer := 0;
  v_ranked boolean;
begin
  if p_winner not in ('A', 'B') then
    raise exception 'INVALID_WINNER';
  end if;
  select * into m from public.team_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status in ('completed', 'cancelled') then
    raise exception 'MATCH_CLOSED';
  end if;
  v_ranked := m.tournament_id is null and not m.friendly;

  if v_ranked then
    v_gain := (m.stakes -> p_winner ->> 'win')::integer;
    v_loss := v_gain; -- somme nulle
    update public.teams set points = points + v_gain, wins = wins + 1 where id = case when p_winner = 'A' then m.team_a else m.team_b end;
    update public.teams set points = greatest(0, points - v_loss), losses = losses + 1 where id = case when p_winner = 'A' then m.team_b else m.team_a end;
  end if;

  -- XP : seulement les joueurs du match.
  update public.cod_profiles set xp = xp + 500 where user_id = any (case when p_winner = 'A' then m.roster_a else m.roster_b end);
  update public.cod_profiles set xp = xp + 150 where user_id = any (case when p_winner = 'A' then m.roster_b else m.roster_a end);

  update public.team_matches
     set status = 'completed', winner = p_winner, scores = p_scores, pending_scores = null, forfeit = p_forfeit,
         points_changes = case when v_ranked
                               then jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_loss)
                               else '{}'::jsonb end,
         resolved_by = p_resolved_by, completed_at = now(), updated_at = now(), activity_at = now()
   where id = p_match
  returning * into m;
  if m.challenge_id is not null then
    update public.team_challenges set status = 'played' where id = m.challenge_id;
  end if;
  return m;
end;
$$;

revoke execute on function public.team_match_create_direct(uuid, uuid, uuid[], uuid[], text[], text, boolean, uuid) from public, anon, authenticated;
grant execute on function public.team_match_create_direct(uuid, uuid, uuid[], uuid[], text[], text, boolean, uuid) to service_role;
revoke execute on function public.team_match_finalize(uuid, jsonb, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.team_match_finalize(uuid, jsonb, text, uuid, boolean) to service_role;
