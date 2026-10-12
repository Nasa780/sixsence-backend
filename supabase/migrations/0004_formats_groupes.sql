-- =============================================================================
-- SixSence — migration 0004 : files par format (2v2, 5v5…) et jeu en groupe
--   1. File : format et groupe de chaque joueur
--   2. Groupes (parties) : un chef, des membres, un code d'invitation
--   3. Matchs : format, groupes et tailles de groupe au moment du match
--   4. Entrée en file d'un groupe, création atomique d'un match proposé par le serveur
--   5. Vérification « Prêt ? » expirée : un groupe n'est remis en file que complet
--   6. Barème selon la taille du groupe (solo protégé, groupes de 3+ moins payés)
-- À exécuter après 0003. Idempotent. Compatible avec l'ancien serveur pendant le
-- déploiement (les anciennes fonctions restent en place).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. FILE
-- -----------------------------------------------------------------------------
alter table public.cod_queue add column if not exists format     text    not null default '5v5';
alter table public.cod_queue add column if not exists group_id   uuid    not null default gen_random_uuid();
alter table public.cod_queue add column if not exists group_size integer not null default 1;

alter table public.cod_queue drop constraint if exists cod_queue_format_check;
alter table public.cod_queue add constraint cod_queue_format_check check (format ~ '^[1-9]v[1-9]$');
alter table public.cod_queue drop constraint if exists cod_queue_group_size_check;
alter table public.cod_queue add constraint cod_queue_group_size_check check (group_size between 1 and 5);

create index if not exists cod_queue_format_idx on public.cod_queue (format, joined_at);
create index if not exists cod_queue_group_idx on public.cod_queue (group_id);


-- -----------------------------------------------------------------------------
-- 2. GROUPES
-- -----------------------------------------------------------------------------
-- Un joueur appartient au plus à un groupe. Le chef choisit le format et lance la file.
create table if not exists public.cod_parties (
  id          uuid primary key default gen_random_uuid(),
  leader_id   uuid not null unique references public.users (id) on delete cascade,
  format      text not null check (format ~ '^[1-9]v[1-9]$'),
  invite_code text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.cod_party_members (
  user_id   uuid primary key references public.users (id) on delete cascade,
  party_id  uuid not null references public.cod_parties (id) on delete cascade,
  joined_at timestamptz not null default now()
);
create index if not exists cod_party_members_party_idx on public.cod_party_members (party_id, joined_at);

-- Le code d'invitation donne accès au groupe : ces tables ne sont lues que par le backend.
alter table public.cod_parties       enable row level security;
alter table public.cod_party_members enable row level security;


-- -----------------------------------------------------------------------------
-- 3. MATCHS
-- -----------------------------------------------------------------------------
alter table public.cod_matches add column if not exists format      text;
alter table public.cod_matches add column if not exists groups      jsonb not null default '{}'::jsonb; -- { joueur: groupe }
alter table public.cod_matches add column if not exists group_sizes jsonb not null default '{}'::jsonb; -- { joueur: taille }
update public.cod_matches set format = team_size || 'v' || team_size where format is null;


-- -----------------------------------------------------------------------------
-- 4. ENTRÉE EN FILE ET CRÉATION DES MATCHS
-- -----------------------------------------------------------------------------

-- Fait entrer un groupe (ou un joueur seul) dans la file d'un format.
-- Tous les membres sont vérifiés ; en cas de problème, l'exception porte le pseudo
-- du joueur concerné dans "detail". Renvoie le nombre de joueurs dans cette file.
create or replace function public.cod_join_queue_group(
  p_format    text,
  p_team_size integer,
  p_members   uuid[],
  p_group     uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count  integer := coalesce(array_length(p_members, 1), 0);
  v_uid    uuid;
  v_name   text;
  v_party  uuid[];
  v_now    timestamptz := clock_timestamp();
  v_size   integer;
begin
  if p_format !~ '^[1-9]v[1-9]$' or p_team_size < 1 or p_team_size > 5 then
    raise exception 'INVALID_FORMAT';
  end if;
  if v_count < 1 or v_count > p_team_size or v_count <> (select count(distinct m) from unnest(p_members) m) then
    raise exception 'INVALID_GROUP_SIZE';
  end if;

  perform pg_advisory_xact_lock(hashtext('sixsence_cod_matchmaking'));

  -- Un groupe déclaré doit correspondre exactement à ses membres actuels.
  if exists (select 1 from public.cod_parties where id = p_group) then
    select array_agg(user_id order by user_id) into v_party from public.cod_party_members where party_id = p_group;
    if v_party is distinct from (select array_agg(m order by m) from unnest(p_members) m) then
      raise exception 'PARTY_CHANGED';
    end if;
  end if;

  -- Déjà en file avec exactement ce groupe : rien à faire.
  if (select count(*) from public.cod_queue where group_id = p_group and user_id = any (p_members)) = v_count
     and (select count(*) from public.cod_queue where group_id = p_group) = v_count then
    select count(*) into v_size from public.cod_queue where format = p_format;
    return v_size;
  end if;

  foreach v_uid in array p_members loop
    select username into v_name from public.users where id = v_uid;
    if not exists (
      select 1 from public.cod_profiles where user_id = v_uid and coalesce(trim(activision_id), '') <> ''
    ) then
      raise exception using message = 'MEMBER_PROFILE_INCOMPLETE', detail = coalesce(v_name, 'Un joueur');
    end if;
    if exists (select 1 from public.cod_profiles where user_id = v_uid and banned_until > now()) then
      raise exception using message = 'MEMBER_BANNED', detail = coalesce(v_name, 'Un joueur');
    end if;
    if public.cod_active_match_id(v_uid) is not null then
      raise exception using message = 'MEMBER_IN_MATCH', detail = coalesce(v_name, 'Un joueur');
    end if;
    if exists (select 1 from public.cod_queue where user_id = v_uid) then
      raise exception using message = 'MEMBER_IN_QUEUE', detail = coalesce(v_name, 'Un joueur');
    end if;
  end loop;

  insert into public.cod_queue (user_id, joined_at, format, group_id, group_size)
  select m, v_now, p_format, p_group, v_count from unnest(p_members) m;

  select count(*) into v_size from public.cod_queue where format = p_format;
  return v_size;
end;
$$;

-- Crée un match à partir d'une proposition du serveur (équipes déjà formées par
-- le matchmaking). Tout est revérifié sous verrou : chaque joueur est encore en
-- file dans ce format, aucun groupe n'est séparé ni incomplet. Si la file a bougé
-- entre-temps, ne crée rien (le serveur recalcule).
create or replace function public.cod_create_group_match(
  p_format        text,
  p_team_size     integer,
  p_team_a        uuid[],
  p_team_b        uuid[],
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
  v_all    uuid[] := p_team_a || p_team_b;
  v_match  public.cod_matches;
  v_season integer;
  v_groups jsonb;
  v_sizes  jsonb;
begin
  if coalesce(array_length(p_team_a, 1), 0) <> p_team_size or coalesce(array_length(p_team_b, 1), 0) <> p_team_size
     or (select count(distinct u) from unnest(v_all) u) <> p_team_size * 2
     or coalesce(array_length(p_maps, 1), 0) = 0 or coalesce(array_length(p_modes, 1), 0) = 0 then
    raise exception 'INVALID_MATCH_CONFIG';
  end if;

  perform pg_advisory_xact_lock(hashtext('sixsence_cod_matchmaking'));

  perform 1 from public.cod_queue where user_id = any (v_all) for update;

  -- Tous encore en file, dans ce format.
  if (select count(*) from public.cod_queue where user_id = any (v_all) and format = p_format) <> p_team_size * 2 then
    return;
  end if;
  -- Aucun groupe incomplet (un membre resté hors du match) ni séparé entre les deux équipes.
  if exists (
    select 1 from public.cod_queue q
     where q.group_id in (select group_id from public.cod_queue where user_id = any (v_all))
       and not (q.user_id = any (v_all))
  ) or exists (
    select 1 from public.cod_queue a
      join public.cod_queue b on a.group_id = b.group_id
     where a.user_id = any (p_team_a) and b.user_id = any (p_team_b)
  ) then
    return;
  end if;

  select jsonb_object_agg(user_id::text, group_id::text), jsonb_object_agg(user_id::text, group_size)
    into v_groups, v_sizes
    from public.cod_queue where user_id = any (v_all);

  select id into v_season from public.seasons where is_active order by id desc limit 1;

  insert into public.cod_matches (status, format, map, mode, team_size, team_a, team_b, ready_deadline, season_id, groups, group_sizes)
  values (
    'ready_check',
    p_format,
    p_maps[1 + floor(random() * array_length(p_maps, 1))::integer],
    p_modes[1 + floor(random() * array_length(p_modes, 1))::integer],
    p_team_size,
    p_team_a,
    p_team_b,
    now() + make_interval(secs => greatest(p_ready_seconds, 10)),
    v_season,
    v_groups,
    v_sizes
  )
  returning * into v_match;

  delete from public.cod_queue where user_id = any (v_all);
  return next v_match;
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. VÉRIFICATION « PRÊT ? » EXPIRÉE
-- -----------------------------------------------------------------------------
-- Comme avant (match annulé, absents sanctionnés), mais par groupe : un groupe
-- n'est remis en tête de file que si tous ses membres avaient accepté. Les joueurs
-- qui avaient accepté mais dont un coéquipier manquait sont libérés (« released »).
drop function if exists public.cod_expire_ready_checks();
create or replace function public.cod_expire_ready_checks()
returns table (match_id uuid, accepted uuid[], missing uuid[], released uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  m          public.cod_matches;
  v_all      uuid[];
  v_miss     uuid[];
  v_requeued uuid[];
  v_uid      uuid;
begin
  for m in
    select * from public.cod_matches
     where status = 'ready_check' and ready_deadline <= now()
     for update skip locked
  loop
    v_all  := m.team_a || m.team_b;
    v_miss := array(select unnest(v_all) except select unnest(m.ready_users));

    -- Joueurs dont tout le groupe a accepté (un joueur sans groupe connu forme son propre groupe).
    v_requeued := array(
      select u from unnest(m.ready_users) u
       where not exists (
         select 1 from unnest(v_miss) x
          where coalesce(m.groups ->> x::text, x::text) = coalesce(m.groups ->> u::text, u::text)
       )
    );

    update public.cod_matches
       set status = 'cancelled', cancel_reason = 'ready_check_failed', completed_at = now()
     where id = m.id;

    -- En tête de file : une date d'entrée antérieure à tous les autres joueurs, groupe conservé.
    foreach v_uid in array v_requeued loop
      insert into public.cod_queue (user_id, joined_at, format, group_id, group_size)
      values (
        v_uid,
        m.created_at - interval '1 day',
        coalesce(m.format, m.team_size || 'v' || m.team_size),
        coalesce((m.groups ->> v_uid::text)::uuid, gen_random_uuid()),
        coalesce((m.group_sizes ->> v_uid::text)::integer, 1)
      )
      on conflict (user_id) do nothing;
    end loop;

    foreach v_uid in array v_miss loop
      perform public.cod_apply_strike(v_uid, 'ready_check_missed', m.id);
    end loop;

    match_id := m.id;
    accepted := v_requeued;
    missing  := v_miss;
    released := array(select unnest(m.ready_users) except select unnest(v_requeued));
    return next;
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. BARÈME SELON LA TAILLE DU GROUPE
-- -----------------------------------------------------------------------------
-- Victoire : +30 (+26 pour un groupe de 3 joueurs ou plus : jouer ensemble est un avantage).
-- Défaite  : pénalité du rang (10 à 30), réduite de 25 % pour un joueur seul.
-- Garder aligné avec lib/ranks.js du site.
create or replace function public.cod_win_points(p_group_size integer)
returns integer
language sql
immutable
as $$
  select case when coalesce(p_group_size, 1) >= 3 then 26 else 30 end;
$$;

create or replace function public.cod_loss_points(p_points integer, p_group_size integer)
returns integer
language sql
immutable
as $$
  select least(
    p_points,
    case when coalesce(p_group_size, 1) = 1
         then round(public.cod_loss_penalty(p_points) * 0.75)::integer
         else public.cod_loss_penalty(p_points)
    end
  );
$$;

create or replace function public.cod_finalize_match(p_match uuid, p_winner text)
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
begin
  if p_winner is null or p_winner not in ('A', 'B') then
    raise exception 'INVALID_WINNER';
  end if;

  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status in ('completed', 'cancelled') then
    raise exception 'MATCH_CLOSED';
  end if;

  if p_winner = 'A' then
    v_winners := m.team_a;
    v_losers  := m.team_b;
  else
    v_winners := m.team_b;
    v_losers  := m.team_a;
  end if;

  -- Variations calculées AVANT la mise à jour (la pénalité dépend du rang actuel).
  select coalesce(jsonb_object_agg(uid::text, delta), '{}'::jsonb)
    into v_changes
    from (
      select w as uid, public.cod_win_points((m.group_sizes ->> w::text)::integer) as delta
        from unnest(v_winners) w
      union all
      select p.user_id, -public.cod_loss_points(p.points, (m.group_sizes ->> p.user_id::text)::integer)
        from public.cod_profiles p
       where p.user_id = any (v_losers)
    ) changes;

  update public.cod_profiles p
     set points      = p.points + (v_changes ->> p.user_id::text)::integer,
         peak_points = greatest(p.peak_points, p.points + (v_changes ->> p.user_id::text)::integer),
         xp          = p.xp + k_win_xp,
         wins        = p.wins + 1,
         win_streak  = p.win_streak + 1,
         best_streak = greatest(p.best_streak, p.win_streak + 1)
   where p.user_id = any (v_winners);

  update public.cod_profiles p
     set points     = greatest(0, p.points + (v_changes ->> p.user_id::text)::integer),
         losses     = p.losses + 1,
         win_streak = 0
   where p.user_id = any (v_losers);

  update public.cod_matches
     set status         = 'completed',
         winner         = p_winner,
         points_changes = v_changes,
         completed_at   = now()
   where id = p_match
  returning * into m;

  return m;
end;
$$;


-- -----------------------------------------------------------------------------
-- DROITS
-- -----------------------------------------------------------------------------
revoke execute on function public.cod_join_queue_group(text, integer, uuid[], uuid)                              from public, anon, authenticated;
revoke execute on function public.cod_create_group_match(text, integer, uuid[], uuid[], text[], text[], integer) from public, anon, authenticated;
revoke execute on function public.cod_expire_ready_checks()                                                      from public, anon, authenticated;
revoke execute on function public.cod_finalize_match(uuid, text)                                                 from public, anon, authenticated;
grant execute on function public.cod_join_queue_group(text, integer, uuid[], uuid)                              to service_role;
grant execute on function public.cod_create_group_match(text, integer, uuid[], uuid[], text[], text[], integer) to service_role;
grant execute on function public.cod_expire_ready_checks()                                                      to service_role;
grant execute on function public.cod_finalize_match(uuid, text)                                                 to service_role;
grant execute on function public.cod_win_points(integer)                                                         to anon, authenticated, service_role;
grant execute on function public.cod_loss_points(integer, integer)                                               to anon, authenticated, service_role;
