-- =============================================================================
-- SixSence — migration 0005 : vote du MVP, demandes d'arbitrage, signalements
--   1. Vote du MVP : après un match terminé, chaque joueur élit le meilleur joueur
--      (24 h pour voter). Badge « MVP du mois » pour le plus élu du mois écoulé.
--   2. Demandes d'arbitrage : un joueur signale un problème pendant un match.
--   3. Signalements de joueurs (triche, comportement…).
-- Arbitrages et signalements sont privés : lus et écrits par le backend uniquement.
-- À exécuter après 0004. Idempotent.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. VOTE DU MVP
-- -----------------------------------------------------------------------------
create table if not exists public.cod_mvp_votes (
  match_id   uuid not null references public.cod_matches (id) on delete cascade,
  voter_id   uuid not null references public.users (id) on delete cascade,
  target_id  uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (match_id, voter_id)
);
create index if not exists cod_mvp_votes_target_idx on public.cod_mvp_votes (target_id, created_at);

-- Vote (ou changement de vote) d'un joueur du match, dans les 24 h qui suivent sa fin.
create or replace function public.cod_vote_mvp(p_match uuid, p_voter uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
begin
  select * into m from public.cod_matches where id = p_match;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (m.team_a @> array[p_voter] or m.team_b @> array[p_voter]) then
    raise exception 'NOT_A_PLAYER';
  end if;
  if not (m.team_a @> array[p_target] or m.team_b @> array[p_target]) or p_target = p_voter then
    raise exception 'INVALID_MVP';
  end if;
  if m.status <> 'completed' or m.completed_at < now() - interval '24 hours' then
    raise exception 'MVP_VOTE_CLOSED';
  end if;

  insert into public.cod_mvp_votes (match_id, voter_id, target_id)
  values (p_match, p_voter, p_target)
  on conflict (match_id, voter_id) do update set target_id = excluded.target_id, created_at = now();
end;
$$;

-- MVP du mois : une ligne par mois attribué.
create table if not exists public.cod_monthly_mvp (
  month      date primary key,            -- premier jour du mois
  user_id    uuid not null references public.users (id) on delete cascade,
  votes      integer not null,
  awarded_at timestamptz not null default now()
);

-- Attribue le MVP d'un mois écoulé (idempotent) : le joueur qui a reçu le plus de
-- votes ce mois-là ; à égalité, celui élu dans le plus de matchs différents, puis
-- celui qui a atteint ce total le premier. Donne le badge « mvp-AAAA-MM ».
-- Renvoie le gagnant (null si personne n'a été élu, ou si le mois n'est pas fini).
create or replace function public.cod_award_monthly_mvp(p_month date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start  timestamptz := date_trunc('month', p_month::timestamp) at time zone 'Europe/Paris';
  v_end    timestamptz := (date_trunc('month', p_month::timestamp) + interval '1 month') at time zone 'Europe/Paris';
  v_winner uuid;
  v_votes  integer;
begin
  if v_end > now() then
    return null;
  end if;
  select user_id into v_winner from public.cod_monthly_mvp where month = date_trunc('month', p_month::timestamp)::date;
  if found then
    return v_winner;
  end if;

  select target_id, count(*)
    into v_winner, v_votes
    from public.cod_mvp_votes
   where created_at >= v_start and created_at < v_end
   group by target_id
   order by count(*) desc, count(distinct match_id) desc, max(created_at) asc
   limit 1;
  if v_winner is null then
    return null;
  end if;

  insert into public.cod_monthly_mvp (month, user_id, votes)
  values (date_trunc('month', p_month::timestamp)::date, v_winner, v_votes)
  on conflict (month) do nothing;

  update public.cod_profiles
     set badges = array(select distinct unnest(badges || array['mvp-' || to_char(p_month, 'YYYY-MM')]))
   where user_id = v_winner;
  return v_winner;
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. DEMANDES D'ARBITRAGE
-- -----------------------------------------------------------------------------
create table if not exists public.cod_arbitration_requests (
  id          bigint generated always as identity primary key,
  match_id    uuid not null references public.cod_matches (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  reason      text not null check (reason in ('cheating', 'afk', 'lobby', 'score', 'behavior', 'other')),
  details     text check (details is null or char_length(details) <= 500),
  status      text not null default 'open' check (status in ('open', 'resolved', 'rejected')),
  resolution  text check (resolution is null or char_length(resolution) <= 500),
  resolved_by uuid references public.users (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists cod_arbitration_status_idx on public.cod_arbitration_requests (status, created_at);
create index if not exists cod_arbitration_match_idx on public.cod_arbitration_requests (match_id);


-- -----------------------------------------------------------------------------
-- 3. SIGNALEMENTS DE JOUEURS
-- -----------------------------------------------------------------------------
create table if not exists public.cod_player_reports (
  id          bigint generated always as identity primary key,
  reporter_id uuid not null references public.users (id) on delete cascade,
  target_id   uuid not null references public.users (id) on delete cascade,
  match_id    uuid references public.cod_matches (id) on delete set null,
  reason      text not null check (reason in ('cheating', 'toxicity', 'afk', 'smurf', 'name', 'other')),
  details     text check (details is null or char_length(details) <= 500),
  status      text not null default 'open' check (status in ('open', 'resolved', 'rejected')),
  resolution  text check (resolution is null or char_length(resolution) <= 500),
  resolved_by uuid references public.users (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  check (reporter_id <> target_id)
);
create index if not exists cod_reports_status_idx on public.cod_player_reports (status, created_at);
create index if not exists cod_reports_reporter_idx on public.cod_player_reports (reporter_id, created_at);


-- -----------------------------------------------------------------------------
-- SÉCURITÉ
-- -----------------------------------------------------------------------------
alter table public.cod_mvp_votes            enable row level security;
alter table public.cod_monthly_mvp          enable row level security;
alter table public.cod_arbitration_requests enable row level security;
alter table public.cod_player_reports       enable row level security;

-- Votes et MVP du mois : publics. Arbitrages et signalements : aucune lecture publique.
drop policy if exists "cod_mvp_votes: lecture publique" on public.cod_mvp_votes;
create policy "cod_mvp_votes: lecture publique" on public.cod_mvp_votes for select to anon, authenticated using (true);
drop policy if exists "cod_monthly_mvp: lecture publique" on public.cod_monthly_mvp;
create policy "cod_monthly_mvp: lecture publique" on public.cod_monthly_mvp for select to anon, authenticated using (true);

revoke execute on function public.cod_vote_mvp(uuid, uuid, uuid)  from public, anon, authenticated;
revoke execute on function public.cod_award_monthly_mvp(date)     from public, anon, authenticated;
grant execute on function public.cod_vote_mvp(uuid, uuid, uuid)  to service_role;
grant execute on function public.cod_award_monthly_mvp(date)     to service_role;

-- Temps réel : le décompte des votes se met à jour en direct dans le salon de match.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cod_mvp_votes'
     ) then
    alter publication supabase_realtime add table public.cod_mvp_votes;
  end if;
end;
$$;
