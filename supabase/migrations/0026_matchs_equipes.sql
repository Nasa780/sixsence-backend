-- =============================================================================
-- 0026 : matchs d'équipe (mode « Match team », étape 2)
-- =============================================================================
--   * team_queue : équipes en recherche (le Leader inscrit ses titulaires) ;
--   * team_matches : BO3 en 4v4, maps 1 et 2 tirées au sort, map 3 choisie par l'équipe qui a
--     gagné le plus de manches (égalité : tirage au sort) ; scores déclarés par un Leader et
--     confirmés par un Leader adverse ; points d'équipe façon Elo (enjeux fixés à la création) ;
--   * team_match_create : sort deux équipes de la file (plus anciennes d'abord) et crée le match ;
--   * team_match_finalize : clôture atomique (vainqueur, points et bilan des deux équipes).
-- Lecture publique des matchs ; file et écritures par le backend uniquement.

create table if not exists public.team_queue (
  team_id   uuid primary key references public.teams (id) on delete cascade,
  roster    uuid[] not null,
  queued_by uuid not null references public.users (id),
  joined_at timestamptz not null default now()
);

create table if not exists public.team_matches (
  id               uuid primary key default gen_random_uuid(),
  season_id        integer references public.seasons (id),
  team_a           uuid not null references public.teams (id),
  team_b           uuid not null references public.teams (id),
  roster_a         uuid[] not null,
  roster_b         uuid[] not null,
  points_a         integer not null,
  points_b         integer not null,
  -- Enjeux : { "A": { "win": 31, "loss": 19 }, "B": { "win": 19, "loss": 31 } }
  stakes           jsonb not null,
  mode             text not null,
  -- Maps jouées : [ { "map": "Exposure", "pick": "random" }, …, { "map": "Den", "pick": "B" } ]
  maps             jsonb not null,
  -- Scores confirmés, du point de vue de l'équipe A : [ [6, 4], [3, 6] ]
  scores           jsonb not null default '[]'::jsonb,
  map3_picker      text check (map3_picker in ('A', 'B', 'random')),
  status           text not null default 'in_progress'
                     check (status in ('in_progress', 'awaiting_confirmation', 'disputed', 'completed', 'cancelled')),
  pending_scores   jsonb,
  reported_by      uuid references public.users (id),
  reported_team    text check (reported_team in ('A', 'B')),
  reported_at      timestamptz,
  winner           text check (winner in ('A', 'B')),
  points_changes   jsonb not null default '{}'::jsonb,
  cancel_reason    text,
  resolved_by      uuid references public.users (id),
  discord_channels jsonb not null default '{}'::jsonb,
  discord_done     boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  check (team_a <> team_b)
);
create index if not exists team_matches_team_a on public.team_matches (team_a, created_at desc);
create index if not exists team_matches_team_b on public.team_matches (team_b, created_at desc);
create index if not exists team_matches_open on public.team_matches (status) where status in ('in_progress', 'awaiting_confirmation', 'disputed');

alter table public.team_queue enable row level security;
alter table public.team_matches enable row level security;
drop policy if exists "team_matches: lecture publique" on public.team_matches;
create policy "team_matches: lecture publique" on public.team_matches for select to anon, authenticated using (true);

-- Enjeux façon Elo (K = 50) : à niveau égal ±25 ; battre une équipe mieux classée rapporte plus,
-- perdre contre une équipe moins bien classée coûte plus. Entre 5 et 45 ; somme nulle.
create or replace function public.team_match_stakes(p_points_a integer, p_points_b integer)
returns jsonb
language sql
immutable
as $$
  with e as (select 1 / (1 + power(10::numeric, (p_points_b - p_points_a) / 400.0)) as a)
  select jsonb_build_object(
    'A', jsonb_build_object('win', least(45, greatest(5, round(50 * (1 - a))::int)), 'loss', least(45, greatest(5, round(50 * a)::int))),
    'B', jsonb_build_object('win', least(45, greatest(5, round(50 * a)::int)), 'loss', least(45, greatest(5, round(50 * (1 - a))::int)))
  )
  from e;
$$;

-- Sort les deux équipes les plus anciennes de la file (sans match en cours) et crée leur match.
-- p_maps : deux maps déjà tirées au sort par le backend. Renvoie null s'il n'y a pas deux équipes.
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
    jsonb_build_array(
      jsonb_build_object('map', p_maps[1], 'pick', 'random'),
      jsonb_build_object('map', p_maps[2], 'pick', 'random')
    )
  )
  returning * into m;
  delete from public.team_queue where team_id in (ta.id, tb.id);
  return m;
end;
$$;

-- Clôture : vainqueur, points (enjeux fixés à la création) et bilan des deux équipes.
create or replace function public.team_match_finalize(p_match uuid, p_scores jsonb, p_winner text, p_resolved_by uuid)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m      public.team_matches;
  v_gain integer;
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

  v_gain := (m.stakes -> p_winner ->> 'win')::integer;
  update public.teams set points = points + v_gain, wins = wins + 1 where id = case when p_winner = 'A' then m.team_a else m.team_b end;
  update public.teams set points = greatest(0, points - v_gain), losses = losses + 1 where id = case when p_winner = 'A' then m.team_b else m.team_a end;

  update public.team_matches
     set status = 'completed', winner = p_winner, scores = p_scores, pending_scores = null,
         points_changes = jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_gain),
         resolved_by = p_resolved_by, completed_at = now(), updated_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

revoke execute on function public.team_match_create(text[], text) from public, anon, authenticated;
revoke execute on function public.team_match_finalize(uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.team_match_create(text[], text) to service_role;
grant execute on function public.team_match_finalize(uuid, jsonb, text, uuid) to service_role;
grant execute on function public.team_match_stakes(integer, integer) to anon, authenticated, service_role;
