-- =============================================================================
-- 0033 : Division, version 2 (déroulé d'un match, recherche, XP)
-- =============================================================================
--   * points d'équipe : +20 à +30 en victoire, -20 à -30 en défaite selon l'écart, échelle 200
--     (somme nulle : l'une gagne ce que l'autre perd) ;
--   * recherche : 30 min au plus (team_queue.confirmed_at / warned_at), fin de recherche retenue
--     (teams.queue_expired_at) ; pas deux matchs contre la même équipe en moins de p_rematch_minutes ;
--   * match : équipe hôte tirée au sort (host_side), chat (team_match_messages, privé), présence en
--     jeu (present_a / present_b), forfait déclaré par une équipe puis validé par l'autre
--     (statut forfeit_claimed ; sans réponse en 15 min : arbitre) ;
--   * XP des joueurs du match (comme le classé : +500 victoire, +150 défaite), retirée en cas de
--     correction ; les matchs de tournoi aussi.

-- --- Colonnes --------------------------------------------------------------------------------------
alter table public.team_matches add column if not exists host_side text check (host_side in ('A', 'B'));
alter table public.team_matches add column if not exists present_a timestamptz;
alter table public.team_matches add column if not exists present_b timestamptz;
alter table public.team_matches add column if not exists forfeit boolean not null default false;
alter table public.team_matches add column if not exists forfeit_by text check (forfeit_by in ('A', 'B'));
alter table public.team_matches add column if not exists forfeit_reason text check (forfeit_reason in ('host_silent', 'absent'));
alter table public.team_matches add column if not exists forfeit_claimed_at timestamptz;
alter table public.team_matches add column if not exists activity_at timestamptz;

alter table public.team_matches drop constraint if exists team_matches_status_check;
alter table public.team_matches add constraint team_matches_status_check
  check (status in ('in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed', 'completed', 'cancelled'));

alter table public.team_queue add column if not exists confirmed_at timestamptz not null default now();
alter table public.team_queue add column if not exists warned_at timestamptz;
alter table public.teams add column if not exists queue_expired_at timestamptz;

create table if not exists public.team_match_messages (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references public.team_matches (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  side       text check (side in ('A', 'B')),
  body       text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index if not exists team_match_messages_match on public.team_match_messages (match_id, created_at);
alter table public.team_match_messages enable row level security;
-- Aucune politique : chat privé, lu et écrit par le backend (joueurs du match et arbitres).

-- --- Enjeux : +20 à +30 / -20 à -30, échelle 200 ----------------------------------------------------
create or replace function public.team_match_stakes(p_points_a integer, p_points_b integer)
returns jsonb
language sql
immutable
as $$
  with e as (select 1 / (1 + power(10::numeric, (p_points_b - p_points_a) / 200.0)) as a)
  select jsonb_build_object(
    'A', jsonb_build_object('win', round(20 + 10 * (1 - a))::int, 'loss', round(20 + 10 * a)::int),
    'B', jsonb_build_object('win', round(20 + 10 * a)::int, 'loss', round(20 + 10 * (1 - a))::int)
  )
  from e;
$$;

-- --- Création : pas de revanche trop tôt, hôte tiré au sort ------------------------------------------
create or replace function public.team_match_create(p_maps text[], p_mode text, p_rematch_minutes integer)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  qa public.team_queue;
  qb public.team_queue;
  ta public.teams;
  tb public.teams;
  m  public.team_matches;
begin
  perform pg_advisory_xact_lock(hashtext('sixsence_team_matchmaking'));

  for qa in
    select q.* from public.team_queue q
     where not exists (select 1 from public.team_matches x where x.status in ('in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed') and q.team_id in (x.team_a, x.team_b))
     order by q.joined_at
  loop
    select q.* into qb from public.team_queue q
     where q.team_id <> qa.team_id
       and not exists (select 1 from public.team_matches x where x.status in ('in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed') and q.team_id in (x.team_a, x.team_b))
       and not exists (
         select 1 from public.team_matches x
          where x.tournament_id is null
            and x.status <> 'cancelled'
            and x.created_at > now() - make_interval(mins => p_rematch_minutes)
            and ((x.team_a = qa.team_id and x.team_b = q.team_id) or (x.team_a = q.team_id and x.team_b = qa.team_id))
       )
     order by q.joined_at limit 1;
    if found then
      select * into ta from public.teams where id = qa.team_id;
      select * into tb from public.teams where id = qb.team_id;
      insert into public.team_matches (season_id, team_a, team_b, roster_a, roster_b, points_a, points_b, stakes, mode, maps, host_side, activity_at)
      values (
        (select id from public.seasons where is_active limit 1),
        ta.id, tb.id, qa.roster, qb.roster, ta.points, tb.points,
        public.team_match_stakes(ta.points, tb.points),
        p_mode,
        (select jsonb_agg(jsonb_build_object('map', map, 'pick', 'random') order by ord) from unnest(p_maps) with ordinality as t(map, ord)),
        case when random() < 0.5 then 'A' else 'B' end,
        now()
      )
      returning * into m;
      delete from public.team_queue where team_id in (ta.id, tb.id);
      return m;
    end if;
  end loop;
  return null;
end;
$$;

-- --- Clôture : points (hors tournoi), XP des joueurs du match, forfait ---------------------------------
drop function if exists public.team_match_finalize(uuid, jsonb, text, uuid);
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

  if m.tournament_id is null then
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
         points_changes = case when m.tournament_id is null
                               then jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_loss)
                               else '{}'::jsonb end,
         resolved_by = p_resolved_by, completed_at = now(), updated_at = now(), activity_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

-- --- Correction : l'XP suit le changement de résultat ----------------------------------------------------
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

  -- Effets de l'ancien résultat retirés (points, bilan, XP).
  v_old_gain := coalesce((m.points_changes ->> m.winner)::integer, 0);
  v_winner := case when m.winner = 'A' then m.team_a else m.team_b end;
  v_loser  := case when m.winner = 'A' then m.team_b else m.team_a end;
  update public.teams set points = greatest(0, points - v_old_gain), wins = greatest(0, wins - 1) where id = v_winner;
  update public.teams set points = points + v_old_gain, losses = greatest(0, losses - 1) where id = v_loser;
  update public.cod_profiles set xp = greatest(0, xp - 500) where user_id = any (case when m.winner = 'A' then m.roster_a else m.roster_b end);
  update public.cod_profiles set xp = greatest(0, xp - 150) where user_id = any (case when m.winner = 'A' then m.roster_b else m.roster_a end);

  insert into public.team_match_corrections (match_id, staff_id, previous_scores, previous_winner, new_scores, new_winner, reason)
  values (p_match, p_staff, m.scores, m.winner, p_scores, p_winner, v_reason);

  if p_scores is null then
    update public.team_matches
       set status = 'cancelled', cancel_reason = 'staff', winner = null, points_changes = '{}'::jsonb, forfeit = false
     where id = p_match;
  else
    v_gain := (m.stakes -> p_winner ->> 'win')::integer;
    v_winner := case when p_winner = 'A' then m.team_a else m.team_b end;
    v_loser  := case when p_winner = 'A' then m.team_b else m.team_a end;
    update public.teams set points = points + v_gain, wins = wins + 1 where id = v_winner;
    update public.teams set points = greatest(0, points - v_gain), losses = losses + 1 where id = v_loser;
    update public.cod_profiles set xp = xp + 500 where user_id = any (case when p_winner = 'A' then m.roster_a else m.roster_b end);
    update public.cod_profiles set xp = xp + 150 where user_id = any (case when p_winner = 'A' then m.roster_b else m.roster_a end);
    update public.team_matches
       set scores = p_scores, winner = p_winner, forfeit = false,
           points_changes = jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_gain)
     where id = p_match;
  end if;

  update public.team_matches
     set corrected_at = now(), corrected_by = p_staff, correction_reason = v_reason, discord_done = false, updated_at = now(), activity_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

revoke execute on function public.team_match_create(text[], text, integer) from public, anon, authenticated;
revoke execute on function public.team_match_finalize(uuid, jsonb, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.team_match_create(text[], text, integer) to service_role;
grant execute on function public.team_match_finalize(uuid, jsonb, text, uuid, boolean) to service_role;
