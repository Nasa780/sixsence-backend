-- =============================================================================
-- 0028 : tournoi de fin de saison (mode « Match team », étape 3) et saisons des équipes
-- =============================================================================
--   * tournaments : un tournoi (8, 16 ou 32 places), une soirée, statut scheduled → running → completed ;
--   * tournament_teams : qualifiés (tête de série, effectif figé, check-in et titulaires choisis) ;
--   * tournament_bracket : rencontres du tableau (tour, place), reliées au match d'équipe joué ;
--   * team_matches : tournament_id, round, best_of (3, ou 5 en finale) ; les matchs de tournoi ne
--     changent ni les points ni le bilan des équipes ;
--   * teams.trophies : trophées affichés sur la fiche (vainqueur, finaliste) ;
--   * team_season_results + team_close_season : classement final archivé, points remis à 1 000.

alter table public.team_matches add column if not exists tournament_id uuid;
alter table public.team_matches add column if not exists round integer;
alter table public.team_matches add column if not exists best_of integer not null default 3 check (best_of in (3, 5));

alter table public.teams add column if not exists trophies jsonb not null default '[]'::jsonb;

create table if not exists public.tournaments (
  id           uuid primary key default gen_random_uuid(),
  season_id    integer references public.seasons (id),
  name         text not null check (char_length(name) between 3 and 60),
  size         integer not null check (size in (8, 16, 32)),
  starts_at    timestamptz not null,
  status       text not null default 'scheduled' check (status in ('scheduled', 'running', 'completed', 'cancelled')),
  winner_team  uuid references public.teams (id),
  finalist_team uuid references public.teams (id),
  created_by   uuid references public.users (id),
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);
create index if not exists tournaments_recent on public.tournaments (created_at desc);

alter table public.team_matches drop constraint if exists team_matches_tournament_fk;
alter table public.team_matches add constraint team_matches_tournament_fk foreign key (tournament_id) references public.tournaments (id);

create table if not exists public.tournament_teams (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  team_id       uuid not null references public.teams (id),
  seed          integer not null,
  frozen_roster uuid[] not null,
  match_roster  uuid[],
  checked_in_at timestamptz,
  forfeit       boolean not null default false,
  primary key (tournament_id, team_id)
);

create table if not exists public.tournament_bracket (
  id            bigint generated always as identity primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  round         integer not null,
  slot          integer not null,
  team_a        uuid references public.teams (id),
  team_b        uuid references public.teams (id),
  winner        uuid references public.teams (id),
  status        text not null default 'pending' check (status in ('pending', 'playing', 'done', 'empty', 'blocked')),
  match_id      uuid references public.team_matches (id),
  unique (tournament_id, round, slot)
);

create table if not exists public.team_season_results (
  season_id integer not null references public.seasons (id),
  team_id   uuid not null references public.teams (id),
  position  integer not null,
  name      text not null,
  tag       text not null,
  points    integer not null,
  wins      integer not null,
  losses    integer not null,
  primary key (season_id, team_id)
);

alter table public.tournaments enable row level security;
alter table public.tournament_teams enable row level security;
alter table public.tournament_bracket enable row level security;
alter table public.team_season_results enable row level security;
drop policy if exists "tournaments: lecture publique" on public.tournaments;
create policy "tournaments: lecture publique" on public.tournaments for select to anon, authenticated using (true);
drop policy if exists "tournament_teams: lecture publique" on public.tournament_teams;
create policy "tournament_teams: lecture publique" on public.tournament_teams for select to anon, authenticated using (true);
drop policy if exists "tournament_bracket: lecture publique" on public.tournament_bracket;
create policy "tournament_bracket: lecture publique" on public.tournament_bracket for select to anon, authenticated using (true);
drop policy if exists "team_season_results: lecture publique" on public.team_season_results;
create policy "team_season_results: lecture publique" on public.team_season_results for select to anon, authenticated using (true);

-- Création d'un match ordinaire : toutes les maps reçues sont tirées au sort (BO3 : 2 maps).
create or replace function public.team_match_create(p_maps text[], p_mode text)
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

  select q.* into qa from public.team_queue q
   where not exists (select 1 from public.team_matches x where x.status in ('in_progress', 'awaiting_confirmation', 'disputed') and q.team_id in (x.team_a, x.team_b))
   order by q.joined_at limit 1;
  if not found then
    return null;
  end if;
  select q.* into qb from public.team_queue q
   where q.team_id <> qa.team_id
     and not exists (select 1 from public.team_matches x where x.status in ('in_progress', 'awaiting_confirmation', 'disputed') and q.team_id in (x.team_a, x.team_b))
   order by q.joined_at limit 1;
  if not found then
    return null;
  end if;

  select * into ta from public.teams where id = qa.team_id;
  select * into tb from public.teams where id = qb.team_id;
  insert into public.team_matches (season_id, team_a, team_b, roster_a, roster_b, points_a, points_b, stakes, mode, maps)
  values (
    (select id from public.seasons where is_active limit 1),
    ta.id, tb.id, qa.roster, qb.roster, ta.points, tb.points,
    public.team_match_stakes(ta.points, tb.points),
    p_mode,
    (select jsonb_agg(jsonb_build_object('map', map, 'pick', 'random') order by ord) from unnest(p_maps) with ordinality as t(map, ord))
  )
  returning * into m;
  delete from public.team_queue where team_id in (ta.id, tb.id);
  return m;
end;
$$;

-- Crée le match d'une rencontre du tableau (une seule fois) : effectifs choisis au check-in,
-- maps tirées au sort par le backend, pas de points en jeu.
create or replace function public.tournament_create_match(p_entry bigint, p_maps text[], p_mode text, p_best_of integer)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  e  public.tournament_bracket;
  ra uuid[];
  rb uuid[];
  m  public.team_matches;
begin
  select * into e from public.tournament_bracket where id = p_entry for update;
  if not found or e.status <> 'pending' or e.match_id is not null or e.team_a is null or e.team_b is null then
    return null;
  end if;
  select coalesce(match_roster, frozen_roster) into ra from public.tournament_teams where tournament_id = e.tournament_id and team_id = e.team_a;
  select coalesce(match_roster, frozen_roster) into rb from public.tournament_teams where tournament_id = e.tournament_id and team_id = e.team_b;
  insert into public.team_matches (season_id, team_a, team_b, roster_a, roster_b, points_a, points_b, stakes, mode, maps, tournament_id, round, best_of)
  values (
    (select season_id from public.tournaments where id = e.tournament_id),
    e.team_a, e.team_b, ra, rb,
    (select points from public.teams where id = e.team_a), (select points from public.teams where id = e.team_b),
    '{"A": {"win": 0, "loss": 0}, "B": {"win": 0, "loss": 0}}'::jsonb,
    p_mode,
    (select jsonb_agg(jsonb_build_object('map', map, 'pick', 'random') order by ord) from unnest(p_maps) with ordinality as t(map, ord)),
    e.tournament_id, e.round, p_best_of
  )
  returning * into m;
  update public.tournament_bracket set status = 'playing', match_id = m.id where id = p_entry;
  return m;
end;
$$;

-- Clôture : vainqueur ; points et bilan des équipes seulement hors tournoi.
create or replace function public.team_match_finalize(p_match uuid, p_scores jsonb, p_winner text, p_resolved_by uuid)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m      public.team_matches;
  v_gain integer := 0;
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
    update public.teams set points = points + v_gain, wins = wins + 1 where id = case when p_winner = 'A' then m.team_a else m.team_b end;
    update public.teams set points = greatest(0, points - v_gain), losses = losses + 1 where id = case when p_winner = 'A' then m.team_b else m.team_a end;
  end if;

  update public.team_matches
     set status = 'completed', winner = p_winner, scores = p_scores, pending_scores = null,
         points_changes = case when m.tournament_id is null
                               then jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_gain)
                               else '{}'::jsonb end,
         resolved_by = p_resolved_by, completed_at = now(), updated_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

-- Fin de saison des équipes : classement final archivé (équipes actives ayant joué), points remis à 1 000.
create or replace function public.team_close_season(p_season integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.team_season_results (season_id, team_id, position, name, tag, points, wins, losses)
  select p_season, id, row_number() over (order by points desc, wins desc, created_at), name, tag, points, wins, losses
    from public.teams
   where disbanded_at is null and wins + losses > 0
  on conflict (season_id, team_id) do nothing;
  get diagnostics v_count = row_count;
  update public.teams set points = 1000, wins = 0, losses = 0 where disbanded_at is null;
  delete from public.team_queue;
  return v_count;
end;
$$;

revoke execute on function public.tournament_create_match(bigint, text[], text, integer) from public, anon, authenticated;
revoke execute on function public.team_close_season(integer) from public, anon, authenticated;
grant execute on function public.tournament_create_match(bigint, text[], text, integer) to service_role;
grant execute on function public.team_close_season(integer) to service_role;
