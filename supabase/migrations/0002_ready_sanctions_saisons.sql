-- =============================================================================
-- SixSence — migration 0002
--   1. Vérification « Prêt ? » : 1 minute pour accepter un match trouvé
--   2. Sanctions : avertissements puis exclusions temporaires de la file
--   3. Preuves des litiges : captures d'écran (Supabase Storage)
--   4. Saisons : archive du classement, badges, remise à zéro
--   5. Suivi des salons Discord d'un match
-- À exécuter après 0001_init.sql. Idempotent (peut être relancé).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. VÉRIFICATION « PRÊT ? »
-- -----------------------------------------------------------------------------
-- Un match trouvé démarre en 'ready_check' : chaque joueur a ready_deadline pour
-- accepter. Tous prêts -> 'in_progress'. Délai dépassé -> match annulé, ceux qui
-- ont accepté repartent en tête de file, les absents reçoivent un avertissement.

alter table public.cod_matches drop constraint if exists cod_matches_status_check;
alter table public.cod_matches add constraint cod_matches_status_check
  check (status in ('ready_check', 'in_progress', 'awaiting_confirmation', 'disputed', 'completed', 'cancelled'));

alter table public.cod_matches add column if not exists ready_deadline   timestamptz;
alter table public.cod_matches add column if not exists ready_users      uuid[] not null default '{}';
alter table public.cod_matches add column if not exists started_at       timestamptz;
alter table public.cod_matches add column if not exists cancel_reason    text;
alter table public.cod_matches add column if not exists season_id        integer;
alter table public.cod_matches add column if not exists discord_channels jsonb not null default '{}'::jsonb;
alter table public.cod_matches add column if not exists discord_done     boolean not null default false;

-- Un match en vérification compte comme « en cours » (on ne peut pas relancer la file).
create or replace function public.cod_active_match_id(p_user uuid)
returns uuid
language sql
stable
set search_path = public
as $$
  select id
    from public.cod_matches
   where status in ('ready_check', 'in_progress', 'awaiting_confirmation')
     and (team_a @> array[p_user] or team_b @> array[p_user])
   order by created_at desc
   limit 1;
$$;


-- -----------------------------------------------------------------------------
-- 2. SANCTIONS
-- -----------------------------------------------------------------------------
-- Chaque vérification « Prêt ? » manquée donne un avertissement (strike).
-- Sur 24 heures glissantes : 1er = simple avertissement, 2e = 15 min sans file,
-- 3e = 1 h, 4e et suivants = 24 h.

alter table public.cod_profiles add column if not exists banned_until timestamptz;

create table if not exists public.cod_strikes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  reason     text not null,
  match_id   uuid references public.cod_matches (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists cod_strikes_user_idx on public.cod_strikes (user_id, created_at desc);

-- Enregistre un avertissement et applique l'exclusion correspondante. Renvoie la fin de l'exclusion (ou null).
create or replace function public.cod_apply_strike(p_user uuid, p_reason text, p_match uuid default null)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count   integer;
  v_minutes integer;
  v_until   timestamptz;
begin
  insert into public.cod_strikes (user_id, reason, match_id) values (p_user, p_reason, p_match);

  select count(*) into v_count
    from public.cod_strikes
   where user_id = p_user and created_at > now() - interval '24 hours';

  v_minutes := case
    when v_count <= 1 then 0
    when v_count = 2  then 15
    when v_count = 3  then 60
    else 1440
  end;

  if v_minutes = 0 then
    return null;
  end if;

  update public.cod_profiles
     set banned_until = greatest(coalesce(banned_until, now()), now()) + make_interval(mins => v_minutes)
   where user_id = p_user
  returning banned_until into v_until;
  return v_until;
end;
$$;

-- Entrée dans la file : refusée si le joueur est exclu temporairement.
create or replace function public.cod_join_queue(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_size integer;
begin
  if not exists (
    select 1 from public.cod_profiles
     where user_id = p_user and coalesce(trim(activision_id), '') <> ''
  ) then
    raise exception 'PROFILE_INCOMPLETE';
  end if;

  if exists (select 1 from public.cod_profiles where user_id = p_user and banned_until > now()) then
    raise exception 'QUEUE_BANNED';
  end if;

  if public.cod_active_match_id(p_user) is not null then
    raise exception 'ALREADY_IN_MATCH';
  end if;

  insert into public.cod_queue (user_id) values (p_user)
  on conflict (user_id) do nothing;

  select count(*) into v_size from public.cod_queue;
  return v_size;
end;
$$;

-- Création de match : démarre en vérification « Prêt ? » (p_ready_seconds pour accepter).
drop function if exists public.cod_try_create_match(integer, text[], text[]);
create or replace function public.cod_try_create_match(
  p_team_size     integer,
  p_maps          text[],
  p_modes         text[],
  p_ready_seconds integer default 60
)
returns setof public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_needed integer := p_team_size * 2;
  v_ids    uuid[];
  v_match  public.cod_matches;
  v_season integer;
begin
  if p_team_size < 1 or coalesce(array_length(p_maps, 1), 0) = 0 or coalesce(array_length(p_modes, 1), 0) = 0 then
    raise exception 'INVALID_MATCH_CONFIG';
  end if;

  perform pg_advisory_xact_lock(hashtext('sixsence_cod_matchmaking'));

  select array_agg(q.user_id order by random())
    into v_ids
    from (
      select user_id
        from public.cod_queue
       order by joined_at asc
       limit v_needed
         for update
    ) q;

  if v_ids is null or array_length(v_ids, 1) < v_needed then
    return;
  end if;

  select id into v_season from public.seasons where is_active order by id desc limit 1;

  insert into public.cod_matches (status, map, mode, team_size, team_a, team_b, ready_deadline, season_id)
  values (
    'ready_check',
    p_maps[1 + floor(random() * array_length(p_maps, 1))::integer],
    p_modes[1 + floor(random() * array_length(p_modes, 1))::integer],
    p_team_size,
    v_ids[1 : p_team_size],
    v_ids[p_team_size + 1 : v_needed],
    now() + make_interval(secs => greatest(p_ready_seconds, 10)),
    v_season
  )
  returning * into v_match;

  delete from public.cod_queue where user_id = any (v_ids);

  return next v_match;
end;
$$;

-- Un joueur accepte le match. Le dernier à accepter le fait démarrer.
create or replace function public.cod_ready(p_match uuid, p_user uuid)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
begin
  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (m.team_a @> array[p_user] or m.team_b @> array[p_user]) then
    raise exception 'NOT_A_PLAYER';
  end if;
  if m.status <> 'ready_check' then
    -- Déjà démarré : accepter à nouveau ne fait rien.
    if m.status = 'in_progress' then
      return m;
    end if;
    raise exception 'READY_CHECK_CLOSED';
  end if;
  if m.ready_deadline <= now() then
    raise exception 'READY_CHECK_CLOSED';
  end if;

  if not (m.ready_users @> array[p_user]) then
    m.ready_users := m.ready_users || p_user;
  end if;

  if coalesce(array_length(m.ready_users, 1), 0) >= m.team_size * 2 then
    update public.cod_matches
       set ready_users = m.ready_users, status = 'in_progress', started_at = now()
     where id = p_match
    returning * into m;
  else
    update public.cod_matches set ready_users = m.ready_users where id = p_match returning * into m;
  end if;
  return m;
end;
$$;

-- Clôt les vérifications expirées. Pour chaque match :
--   * annulé (cancel_reason = 'ready_check_failed'),
--   * ceux qui ont accepté repartent en tête de file,
--   * les absents reçoivent un avertissement (et éventuellement une exclusion).
-- Renvoie une ligne par match clôturé, pour prévenir les joueurs.
create or replace function public.cod_expire_ready_checks()
returns table (match_id uuid, accepted uuid[], missing uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  m       public.cod_matches;
  v_all   uuid[];
  v_miss  uuid[];
  v_uid   uuid;
begin
  for m in
    select * from public.cod_matches
     where status = 'ready_check' and ready_deadline <= now()
     for update skip locked
  loop
    v_all  := m.team_a || m.team_b;
    v_miss := array(select unnest(v_all) except select unnest(m.ready_users));

    update public.cod_matches
       set status = 'cancelled', cancel_reason = 'ready_check_failed', completed_at = now()
     where id = m.id;

    -- En tête de file : une date d'entrée antérieure à tous les autres joueurs.
    foreach v_uid in array m.ready_users loop
      insert into public.cod_queue (user_id, joined_at)
      values (v_uid, m.created_at - interval '1 day')
      on conflict (user_id) do nothing;
    end loop;

    foreach v_uid in array v_miss loop
      perform public.cod_apply_strike(v_uid, 'ready_check_missed', m.id);
    end loop;

    match_id := m.id;
    accepted := m.ready_users;
    missing  := v_miss;
    return next;
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. PREUVES DES LITIGES
-- -----------------------------------------------------------------------------
-- Les joueurs d'un match envoient des captures du tableau des scores dans le
-- bucket "match-proofs", sous <match_id>/<user_id>/<fichier>. Lecture publique.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('match-proofs', 'match-proofs', true, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "match-proofs: envoi par les joueurs du match" on storage.objects;
create policy "match-proofs: envoi par les joueurs du match" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'match-proofs'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[1] in (
      select id::text from public.cod_matches
       where (team_a @> array[auth.uid()] or team_b @> array[auth.uid()])
         and status in ('in_progress', 'awaiting_confirmation', 'disputed')
    )
  );

create table if not exists public.cod_match_proofs (
  id           bigint generated always as identity primary key,
  match_id     uuid not null references public.cod_matches (id) on delete cascade,
  user_id      uuid not null references public.users (id) on delete cascade,
  storage_path text not null unique,
  created_at   timestamptz not null default now()
);
create index if not exists cod_match_proofs_match_idx on public.cod_match_proofs (match_id);

-- Enregistre une preuve déjà envoyée dans le bucket (5 par joueur et par match au plus).
create or replace function public.cod_add_proof(p_match uuid, p_user uuid, p_path text)
returns public.cod_match_proofs
language plpgsql
security definer
set search_path = public
as $$
declare
  m     public.cod_matches;
  proof public.cod_match_proofs;
begin
  select * into m from public.cod_matches where id = p_match;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (m.team_a @> array[p_user] or m.team_b @> array[p_user]) then
    raise exception 'NOT_A_PLAYER';
  end if;
  if m.status not in ('in_progress', 'awaiting_confirmation', 'disputed') then
    raise exception 'MATCH_CLOSED';
  end if;
  if p_path is null or p_path not like (p_match::text || '/' || p_user::text || '/%') or p_path like '%..%' then
    raise exception 'INVALID_PROOF';
  end if;
  if (select count(*) from public.cod_match_proofs where match_id = p_match and user_id = p_user) >= 5 then
    raise exception 'TOO_MANY_PROOFS';
  end if;

  insert into public.cod_match_proofs (match_id, user_id, storage_path)
  values (p_match, p_user, p_path)
  returning * into proof;
  return proof;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. SAISONS
-- -----------------------------------------------------------------------------

create table if not exists public.seasons (
  id        integer generated always as identity primary key,
  name      text not null,
  starts_at timestamptz not null default now(),
  ends_at   timestamptz,
  is_active boolean not null default false
);
create unique index if not exists seasons_one_active_idx on public.seasons (is_active) where is_active;

insert into public.seasons (name, is_active)
select 'Saison 1', true
where not exists (select 1 from public.seasons);

create table if not exists public.season_results (
  season_id integer not null references public.seasons (id) on delete cascade,
  user_id   uuid not null references public.users (id) on delete cascade,
  position  integer not null,
  username  text not null,
  points    integer not null,
  wins      integer not null,
  losses    integer not null,
  primary key (season_id, user_id)
);

update public.cod_matches set season_id = (select id from public.seasons where is_active limit 1) where season_id is null;

-- Clôture la saison active : archive le classement, attribue les badges
-- (s<id>-champion au 1er, s<id>-top10 aux dix premiers), remet points,
-- victoires, défaites et séries à zéro, puis ouvre la saison suivante.
-- L'XP et le record de série sont conservés. Renvoie le nombre de joueurs archivés.
create or replace function public.cod_close_season(p_next_name text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season  public.seasons;
  v_count   integer;
begin
  if p_next_name is null or char_length(trim(p_next_name)) not between 2 and 40 then
    raise exception 'INVALID_SEASON_NAME';
  end if;

  perform pg_advisory_xact_lock(hashtext('sixsence_cod_matchmaking'));

  select * into v_season from public.seasons where is_active for update;
  if not found then
    raise exception 'NO_ACTIVE_SEASON';
  end if;

  if exists (select 1 from public.cod_matches where status in ('ready_check', 'in_progress', 'awaiting_confirmation', 'disputed')) then
    raise exception 'MATCHES_IN_PROGRESS';
  end if;

  insert into public.season_results (season_id, user_id, position, username, points, wins, losses)
  select v_season.id, l.user_id, row_number() over (order by l.points desc, l.wins desc), l.username, l.points, l.wins, l.losses
    from public.cod_leaderboard l;
  get diagnostics v_count = row_count;

  update public.cod_profiles p
     set badges = array(select distinct unnest(p.badges || array['s' || v_season.id || '-top10']))
    from public.season_results r
   where r.season_id = v_season.id and r.user_id = p.user_id and r.position <= 10;

  update public.cod_profiles p
     set badges = array(select distinct unnest(p.badges || array['s' || v_season.id || '-champion']))
    from public.season_results r
   where r.season_id = v_season.id and r.user_id = p.user_id and r.position = 1;

  delete from public.cod_queue;
  delete from public.cod_leaderboard;
  update public.cod_profiles
     set points = 0, peak_points = 0, wins = 0, losses = 0, win_streak = 0
   where wins + losses > 0 or points > 0;

  update public.seasons set is_active = false, ends_at = now() where id = v_season.id;
  insert into public.seasons (name, is_active) values (trim(p_next_name), true);

  return v_count;
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. SÉCURITÉ
-- -----------------------------------------------------------------------------

alter table public.cod_strikes      enable row level security;
alter table public.cod_match_proofs enable row level security;
alter table public.seasons          enable row level security;
alter table public.season_results   enable row level security;

-- Lecture publique (le site est visible par tous), écritures par le backend uniquement.
do $$
declare
  t text;
begin
  foreach t in array array['cod_strikes', 'cod_match_proofs', 'seasons', 'season_results'] loop
    execute format('drop policy if exists "%s: lecture publique" on public.%I', t, t);
    execute format('create policy "%s: lecture publique" on public.%I for select to anon, authenticated using (true)', t, t);
  end loop;
end;
$$;

revoke execute on function public.cod_apply_strike(uuid, text, uuid)                     from public, anon, authenticated;
revoke execute on function public.cod_join_queue(uuid)                                    from public, anon, authenticated;
revoke execute on function public.cod_try_create_match(integer, text[], text[], integer) from public, anon, authenticated;
revoke execute on function public.cod_ready(uuid, uuid)                                   from public, anon, authenticated;
revoke execute on function public.cod_expire_ready_checks()                               from public, anon, authenticated;
revoke execute on function public.cod_add_proof(uuid, uuid, text)                         from public, anon, authenticated;
revoke execute on function public.cod_close_season(text)                                  from public, anon, authenticated;

grant execute on function public.cod_apply_strike(uuid, text, uuid)                     to service_role;
grant execute on function public.cod_join_queue(uuid)                                    to service_role;
grant execute on function public.cod_try_create_match(integer, text[], text[], integer) to service_role;
grant execute on function public.cod_ready(uuid, uuid)                                   to service_role;
grant execute on function public.cod_expire_ready_checks()                               to service_role;
grant execute on function public.cod_add_proof(uuid, uuid, text)                         to service_role;
grant execute on function public.cod_close_season(text)                                  to service_role;
grant execute on function public.cod_active_match_id(uuid)                               to anon, authenticated, service_role;

-- Temps réel : les preuves apparaissent en direct sur la page du match.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cod_match_proofs'
     ) then
    alter publication supabase_realtime add table public.cod_match_proofs;
  end if;
end;
$$;
