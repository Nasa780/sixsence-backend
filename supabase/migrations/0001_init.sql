-- =============================================================================
-- SixSence — schéma de la plateforme (COD classé + événements GTA 6)
-- =============================================================================
-- À exécuter dans Supabase : SQL Editor > New query > Run.
-- Le script est idempotent (if not exists / or replace) : il peut être relancé.
--
-- Principe :
--   * Tout est LISIBLE publiquement (visiteurs compris) : classement, profils,
--     matchs, événements, fondateurs, partenaires.
--   * Toutes les ÉCRITURES (file d'attente, matchs, points, chat, inscriptions)
--     passent par le backend Render, qui utilise la clé secrète et appelle les
--     fonctions SQL ci-dessous. Elles sont atomiques : deux requêtes simultanées
--     ne peuvent pas créer deux matchs avec les mêmes joueurs, ni dépasser la
--     capacité d'un événement.
--   * Seule exception : un joueur connecté peut modifier son identifiant
--     Activision et sa plateforme (droits par colonne, section 4).
--
-- Barème (identique à la page Ranked du site) :
--   victoire : +30 points, +500 XP
--   défaite  : -10 (Bronze) à -30 (Champion) selon le rang du perdant, jamais sous 0
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. NETTOYAGE DE L'ANCIEN SCHÉMA
-- -----------------------------------------------------------------------------
-- L'ancienne table users (backend avant refonte) n'a pas la même structure.
-- Si c'est bien l'ancienne version (pas de colonne "role"), on la RENOMME en
-- users_legacy au lieu de la supprimer : rien n'est perdu. Elle garde RLS
-- activé sans politique, donc reste illisible depuis le site (elle contient
-- des e-mails). Elle pourra être supprimée à la main plus tard.
do $$
declare
  r record;
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'users'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'users' and column_name = 'role'
  ) then
    if exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'users_legacy'
    ) then
      raise exception 'users_legacy existe déjà : vérifier la base avant de relancer';
    end if;
    alter table public.users rename to users_legacy;
    alter table public.users_legacy enable row level security;

    -- Les noms de contraintes et d'index sont uniques par schéma : on les
    -- préfixe pour libérer users_pkey, etc. pour la nouvelle table users.
    for r in
      select conname from pg_constraint where conrelid = 'public.users_legacy'::regclass
    loop
      execute format('alter table public.users_legacy rename constraint %I to %I', r.conname, 'legacy_' || r.conname);
    end loop;
    for r in
      select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'users_legacy' and indexname not like 'legacy\_%'
    loop
      execute format('alter index public.%I rename to %I', r.indexname, 'legacy_' || r.indexname);
    end loop;
  end if;

  -- Ses anciennes règles laissaient n'importe qui lire / modifier / supprimer
  -- les comptes avec la clé publique : on les retire (accès refusé à tous,
  -- sauf la clé secrète et le tableau de bord Supabase).
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'users_legacy'
  ) then
    for r in
      select policyname from pg_policies where schemaname = 'public' and tablename = 'users_legacy'
    loop
      execute format('drop policy %I on public.users_legacy', r.policyname);
    end loop;
    revoke all on public.users_legacy from anon, authenticated;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- 1. TABLES
-- -----------------------------------------------------------------------------

-- users : miroir public de auth.users, alimenté automatiquement à la connexion
-- Discord (trigger handle_auth_user_sync).
create table if not exists public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  discord_id  text,
  username    text not null,
  avatar_url  text,
  role        text not null default 'member' check (role in ('member', 'admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists users_discord_id_idx on public.users (discord_id);

-- cod_profiles : une ligne par joueur. Points, XP et compteurs ne sont modifiés
-- que par cod_finalize_match.
create table if not exists public.cod_profiles (
  user_id       uuid primary key references public.users (id) on delete cascade,
  activision_id text check (activision_id is null or char_length(activision_id) between 3 and 40),
  platform      text check (platform is null or platform in ('pc', 'playstation', 'xbox')),
  points        integer not null default 0 check (points >= 0),
  peak_points   integer not null default 0,
  xp            integer not null default 0 check (xp >= 0),
  wins          integer not null default 0 check (wins >= 0),
  losses        integer not null default 0 check (losses >= 0),
  win_streak    integer not null default 0,
  best_streak   integer not null default 0,
  badges        text[]  not null default '{}',   -- badges attribués à la main (ex. 'founder', 'beta')
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- cod_queue : la file d'attente classée. Une ligne = un joueur en attente.
create table if not exists public.cod_queue (
  user_id   uuid primary key references public.users (id) on delete cascade,
  joined_at timestamptz not null default now()
);
create index if not exists cod_queue_joined_at_idx on public.cod_queue (joined_at);

-- cod_matches : un match classé. Les équipes sont des tableaux d'identifiants.
--   in_progress            -> le match se joue
--   awaiting_confirmation  -> un joueur a déclaré le résultat, l'équipe adverse doit confirmer
--   disputed               -> résultat contesté, un admin tranche
--   completed / cancelled  -> terminé
create table if not exists public.cod_matches (
  id              uuid primary key default gen_random_uuid(),
  status          text not null default 'in_progress'
                  check (status in ('in_progress', 'awaiting_confirmation', 'disputed', 'completed', 'cancelled')),
  map             text not null,
  mode            text not null,
  team_size       integer not null check (team_size > 0),
  team_a          uuid[] not null,
  team_b          uuid[] not null,
  winner          text check (winner in ('A', 'B')),
  reported_winner text check (reported_winner in ('A', 'B')),
  reported_by     uuid references public.users (id) on delete set null,
  reported_at     timestamptz,
  confirmed_by    uuid references public.users (id) on delete set null,
  points_changes  jsonb not null default '{}'::jsonb,  -- { "<user_id>": 30, "<user_id>": -12, ... }
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);
create index if not exists cod_matches_team_a_idx on public.cod_matches using gin (team_a);
create index if not exists cod_matches_team_b_idx on public.cod_matches using gin (team_b);
create index if not exists cod_matches_status_idx on public.cod_matches (status);
create index if not exists cod_matches_created_at_idx on public.cod_matches (created_at desc);

-- cod_match_messages : chat de la salle de match (écrit par le backend, joueurs du match uniquement).
create table if not exists public.cod_match_messages (
  id         bigint generated always as identity primary key,
  match_id   uuid not null references public.cod_matches (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index if not exists cod_match_messages_match_idx on public.cod_match_messages (match_id, created_at);

-- cod_leaderboard : classement dénormalisé (pseudo + avatar inclus) pour être lu
-- en une seule requête et diffusé en temps réel. Tenu à jour par trigger.
create table if not exists public.cod_leaderboard (
  user_id    uuid primary key references public.users (id) on delete cascade,
  username   text not null,
  avatar_url text,
  points     integer not null,
  wins       integer not null default 0,
  losses     integer not null default 0,
  win_streak integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists cod_leaderboard_points_idx on public.cod_leaderboard (points desc, wins desc);

-- gta_events : planning des événements GTA 6.
create table if not exists public.gta_events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 3 and 120),
  description text,
  category    text not null default 'session',
  location    text,
  cover_url   text,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  max_slots   integer check (max_slots is null or max_slots > 0),  -- null = places illimitées
  status      text not null default 'published' check (status in ('draft', 'published', 'cancelled')),
  created_by  uuid references public.users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists gta_events_starts_at_idx on public.gta_events (starts_at);

-- gta_registrations : inscriptions aux événements (une par joueur et par événement).
create table if not exists public.gta_registrations (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.gta_events (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);
create index if not exists gta_registrations_user_idx on public.gta_registrations (user_id);

-- founders : page /founders.
create table if not exists public.founders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  role        text not null,
  bio         text,
  avatar_url  text,
  steam_url   text,
  discord_tag text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- partners : page /partners.
create table if not exists public.partners (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  tier        text not null default 'community' check (tier in ('platinum', 'gold', 'silver', 'community')),
  description text,
  logo_url    text,
  website_url text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 2. SYNCHRONISATION AUTOMATIQUE
-- -----------------------------------------------------------------------------

-- Met à jour updated_at à chaque modification.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

drop trigger if exists cod_profiles_touch_updated_at on public.cod_profiles;
create trigger cod_profiles_touch_updated_at
  before update on public.cod_profiles
  for each row execute function public.touch_updated_at();

-- À chaque connexion Discord, Supabase crée ou met à jour auth.users.
-- Ce trigger recopie le pseudo et l'avatar Discord dans public.users et crée
-- le profil COD au premier passage.
create or replace function public.handle_auth_user_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_username text;
begin
  v_username := left(coalesce(
    nullif(trim(v_meta -> 'custom_claims' ->> 'global_name'), ''),
    nullif(trim(v_meta ->> 'full_name'), ''),
    nullif(trim(v_meta ->> 'name'), ''),
    nullif(trim(v_meta ->> 'user_name'), ''),
    'Joueur'
  ), 40);

  insert into public.users (id, discord_id, username, avatar_url)
  values (
    new.id,
    coalesce(v_meta ->> 'provider_id', v_meta ->> 'sub'),
    v_username,
    v_meta ->> 'avatar_url'
  )
  on conflict (id) do update
    set discord_id = excluded.discord_id,
        username   = excluded.username,
        avatar_url = excluded.avatar_url;

  insert into public.cod_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_sync on auth.users;
create trigger on_auth_user_sync
  after insert or update of raw_user_meta_data on auth.users
  for each row execute function public.handle_auth_user_sync();

-- Rattrapage : comptes créés avant l'installation de ce schéma.
insert into public.users (id, discord_id, username, avatar_url)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'provider_id', u.raw_user_meta_data ->> 'sub'),
  left(coalesce(
    nullif(trim(u.raw_user_meta_data -> 'custom_claims' ->> 'global_name'), ''),
    nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(u.raw_user_meta_data ->> 'name'), ''),
    'Joueur'
  ), 40),
  u.raw_user_meta_data ->> 'avatar_url'
from auth.users u
on conflict (id) do nothing;

insert into public.cod_profiles (user_id)
select id from public.users
on conflict (user_id) do nothing;

-- Le classement suit cod_profiles : un joueur y apparaît dès son premier match terminé.
create or replace function public.sync_cod_leaderboard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.wins + new.losses) > 0 then
    insert into public.cod_leaderboard (user_id, username, avatar_url, points, wins, losses, win_streak, updated_at)
    select new.user_id, u.username, u.avatar_url, new.points, new.wins, new.losses, new.win_streak, now()
    from public.users u
    where u.id = new.user_id
    on conflict (user_id) do update
      set username   = excluded.username,
          avatar_url = excluded.avatar_url,
          points     = excluded.points,
          wins       = excluded.wins,
          losses     = excluded.losses,
          win_streak = excluded.win_streak,
          updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists cod_profiles_sync_leaderboard on public.cod_profiles;
create trigger cod_profiles_sync_leaderboard
  after insert or update of points, wins, losses, win_streak on public.cod_profiles
  for each row execute function public.sync_cod_leaderboard();

-- Si le pseudo ou l'avatar Discord change, le classement suit.
create or replace function public.sync_leaderboard_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.cod_leaderboard
     set username = new.username, avatar_url = new.avatar_url, updated_at = now()
   where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists users_sync_leaderboard_identity on public.users;
create trigger users_sync_leaderboard_identity
  after update of username, avatar_url on public.users
  for each row
  when (old.username is distinct from new.username or old.avatar_url is distinct from new.avatar_url)
  execute function public.sync_leaderboard_identity();


-- -----------------------------------------------------------------------------
-- 3. FONCTIONS MÉTIER (appelées par le backend Render avec la clé secrète)
-- -----------------------------------------------------------------------------
-- Convention d'erreur : chaque fonction lève une exception dont le message est
-- un code en majuscules (ex. EVENT_FULL). Le backend traduit ce code en statut
-- HTTP et en message lisible.

-- Vrai si l'utilisateur courant (côté navigateur) est admin.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

-- Points perdus en cas de défaite, selon le rang (barème de la page Ranked).
create or replace function public.cod_loss_penalty(p_points integer)
returns integer
language sql
immutable
as $$
  select case
    when p_points >= 3500 then 30  -- Champion
    when p_points >= 3000 then 25  -- Grand Maître
    when p_points >= 2500 then 22  -- Maître
    when p_points >= 2000 then 20  -- Diamant
    when p_points >= 1500 then 18  -- Platine
    when p_points >= 1000 then 15  -- Or
    when p_points >= 500  then 12  -- Argent
    else 10                        -- Bronze
  end;
$$;

-- Identifiant du match en cours d'un joueur (ou null).
create or replace function public.cod_active_match_id(p_user uuid)
returns uuid
language sql
stable
set search_path = public
as $$
  select id
    from public.cod_matches
   where status in ('in_progress', 'awaiting_confirmation')
     and (team_a @> array[p_user] or team_b @> array[p_user])
   order by created_at desc
   limit 1;
$$;

-- Historique des matchs d'un joueur, du plus récent au plus ancien.
create or replace function public.cod_matches_for(p_user uuid, p_limit integer default 20)
returns setof public.cod_matches
language sql
stable
set search_path = public
as $$
  select *
    from public.cod_matches
   where team_a @> array[p_user] or team_b @> array[p_user]
   order by created_at desc
   limit least(greatest(p_limit, 1), 100);
$$;

-- Entrée dans la file. Renvoie la taille de la file après l'ajout.
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

  if public.cod_active_match_id(p_user) is not null then
    raise exception 'ALREADY_IN_MATCH';
  end if;

  insert into public.cod_queue (user_id) values (p_user)
  on conflict (user_id) do nothing;

  select count(*) into v_size from public.cod_queue;
  return v_size;
end;
$$;

-- Tente de créer un match. S'il y a assez de joueurs en file :
--   1. prend les 2 x p_team_size joueurs les plus anciens,
--   2. les mélange et les répartit en deux équipes aléatoires,
--   3. tire une carte et un mode au hasard,
--   4. crée le match et retire les joueurs de la file.
-- Renvoie le match créé, ou aucune ligne s'il manque des joueurs.
-- Le verrou consultatif garantit qu'un seul tirage a lieu à la fois.
create or replace function public.cod_try_create_match(
  p_team_size integer,
  p_maps      text[],
  p_modes     text[]
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

  insert into public.cod_matches (map, mode, team_size, team_a, team_b)
  values (
    p_maps[1 + floor(random() * array_length(p_maps, 1))::integer],
    p_modes[1 + floor(random() * array_length(p_modes, 1))::integer],
    p_team_size,
    v_ids[1 : p_team_size],
    v_ids[p_team_size + 1 : v_needed]
  )
  returning * into v_match;

  delete from public.cod_queue where user_id = any (v_ids);

  return next v_match;
end;
$$;

-- Clôture un match selon le barème du site :
--   vainqueurs : +30 points, +500 XP, série +1
--   perdants   : -10 à -30 points selon leur rang (jamais sous 0), série remise à 0
-- Fonction interne, appelée par confirm / resolve / sweep.
create or replace function public.cod_finalize_match(p_match uuid, p_winner text)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  k_win_points constant integer := 30;
  k_win_xp     constant integer := 500;
  m            public.cod_matches;
  v_winners    uuid[];
  v_losers     uuid[];
  v_changes    jsonb;
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
      select unnest(v_winners) as uid, k_win_points as delta
      union all
      select p.user_id, -least(p.points, public.cod_loss_penalty(p.points))
        from public.cod_profiles p
       where p.user_id = any (v_losers)
    ) changes;

  update public.cod_profiles
     set points      = points + k_win_points,
         peak_points = greatest(peak_points, points + k_win_points),
         xp          = xp + k_win_xp,
         wins        = wins + 1,
         win_streak  = win_streak + 1,
         best_streak = greatest(best_streak, win_streak + 1)
   where user_id = any (v_winners);

  update public.cod_profiles
     set points     = greatest(0, points - public.cod_loss_penalty(points)),
         losses     = losses + 1,
         win_streak = 0
   where user_id = any (v_losers);

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

-- Un joueur du match déclare le vainqueur. L'équipe adverse devra confirmer.
create or replace function public.cod_report_match(p_match uuid, p_user uuid, p_winner text)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
begin
  if p_winner is null or p_winner not in ('A', 'B') then
    raise exception 'INVALID_WINNER';
  end if;

  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (m.team_a @> array[p_user] or m.team_b @> array[p_user]) then
    raise exception 'NOT_A_PLAYER';
  end if;
  if m.status <> 'in_progress' then
    raise exception 'MATCH_NOT_REPORTABLE';
  end if;

  update public.cod_matches
     set status          = 'awaiting_confirmation',
         reported_winner = p_winner,
         reported_by     = p_user,
         reported_at     = now()
   where id = p_match
  returning * into m;

  return m;
end;
$$;

-- Un joueur de l'équipe adverse confirme (p_accept = true) ou conteste le résultat.
create or replace function public.cod_confirm_match(p_match uuid, p_user uuid, p_accept boolean)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m                public.cod_matches;
  v_reporter_in_a  boolean;
  v_user_in_a      boolean;
begin
  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status <> 'awaiting_confirmation' then
    raise exception 'MATCH_NOT_CONFIRMABLE';
  end if;
  if not (m.team_a @> array[p_user] or m.team_b @> array[p_user]) then
    raise exception 'NOT_A_PLAYER';
  end if;

  v_reporter_in_a := m.reported_by is not null and m.team_a @> array[m.reported_by];
  v_user_in_a     := m.team_a @> array[p_user];
  if v_reporter_in_a = v_user_in_a then
    raise exception 'SAME_TEAM_AS_REPORTER';
  end if;

  if p_accept then
    update public.cod_matches set confirmed_by = p_user where id = p_match;
    return public.cod_finalize_match(p_match, m.reported_winner);
  end if;

  update public.cod_matches
     set status = 'disputed', confirmed_by = null
   where id = p_match
  returning * into m;
  return m;
end;
$$;

-- Décision d'un admin : p_winner = 'A' ou 'B' pour valider, null pour annuler le match.
create or replace function public.cod_resolve_match(p_match uuid, p_winner text)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
begin
  if p_winner is not null then
    return public.cod_finalize_match(p_match, p_winner);
  end if;

  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status in ('completed', 'cancelled') then
    raise exception 'MATCH_CLOSED';
  end if;

  update public.cod_matches
     set status = 'cancelled', completed_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

-- Ménage périodique, lancé par le backend chaque minute :
--   * un résultat déclaré mais jamais confirmé est validé après p_confirm_minutes,
--   * un match jamais déclaré est annulé après p_cancel_minutes.
-- Sans cela, dix joueurs resteraient bloqués hors de la file.
create or replace function public.cod_sweep_matches(
  p_confirm_minutes integer default 15,
  p_cancel_minutes  integer default 180
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_count integer := 0;
  v_rows  integer;
begin
  for r in
    select id, reported_winner
      from public.cod_matches
     where status = 'awaiting_confirmation'
       and reported_at < now() - make_interval(mins => p_confirm_minutes)
  loop
    perform public.cod_finalize_match(r.id, r.reported_winner);
    v_count := v_count + 1;
  end loop;

  update public.cod_matches
     set status = 'cancelled', completed_at = now()
   where status = 'in_progress'
     and created_at < now() - make_interval(mins => p_cancel_minutes);
  get diagnostics v_rows = row_count;

  return v_count + v_rows;
end;
$$;

-- Message dans le chat d'un match : réservé aux joueurs du match.
create or replace function public.cod_post_message(p_match uuid, p_user uuid, p_body text)
returns public.cod_match_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  m   public.cod_matches;
  msg public.cod_match_messages;
  v_body text := trim(coalesce(p_body, ''));
begin
  if char_length(v_body) = 0 or char_length(v_body) > 300 then
    raise exception 'INVALID_MESSAGE';
  end if;

  select * into m from public.cod_matches where id = p_match;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (m.team_a @> array[p_user] or m.team_b @> array[p_user]) then
    raise exception 'NOT_A_PLAYER';
  end if;

  insert into public.cod_match_messages (match_id, user_id, body)
  values (p_match, p_user, v_body)
  returning * into msg;
  return msg;
end;
$$;

-- Inscription à un événement GTA 6, avec contrôle de capacité sous verrou.
-- Renvoie le nombre d'inscrits après l'opération.
create or replace function public.gta_register(p_event uuid, p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e       public.gta_events;
  v_count integer;
begin
  select * into e from public.gta_events where id = p_event for update;
  if not found or e.status <> 'published' then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if e.starts_at <= now() then
    raise exception 'EVENT_CLOSED';
  end if;

  select count(*) into v_count from public.gta_registrations where event_id = p_event;

  if exists (select 1 from public.gta_registrations where event_id = p_event and user_id = p_user) then
    return v_count;
  end if;

  if e.max_slots is not null and v_count >= e.max_slots then
    raise exception 'EVENT_FULL';
  end if;

  insert into public.gta_registrations (event_id, user_id) values (p_event, p_user);
  return v_count + 1;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. SÉCURITÉ : RLS ET DROITS
-- -----------------------------------------------------------------------------

alter table public.users              enable row level security;
alter table public.cod_profiles       enable row level security;
alter table public.cod_queue          enable row level security;
alter table public.cod_matches        enable row level security;
alter table public.cod_match_messages enable row level security;
alter table public.cod_leaderboard    enable row level security;
alter table public.gta_events         enable row level security;
alter table public.gta_registrations  enable row level security;
alter table public.founders           enable row level security;
alter table public.partners           enable row level security;

-- Tout est lisible publiquement, visiteurs compris (choix du site).
do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'cod_profiles', 'cod_queue', 'cod_matches', 'cod_match_messages',
    'cod_leaderboard', 'gta_registrations', 'founders', 'partners'
  ] loop
    execute format('drop policy if exists "%s: lecture publique" on public.%I', t, t);
    execute format('create policy "%s: lecture publique" on public.%I for select to anon, authenticated using (true)', t, t);
  end loop;
end;
$$;

-- Les brouillons d'événements restent invisibles (sauf pour les admins).
drop policy if exists "gta_events: lecture publique" on public.gta_events;
create policy "gta_events: lecture publique" on public.gta_events
  for select to anon, authenticated using (status <> 'draft' or public.is_admin());

-- Un joueur connecté peut modifier SA ligne de profil (colonnes limitées ci-dessous).
drop policy if exists "cod_profiles: édition de son profil" on public.cod_profiles;
create policy "cod_profiles: édition de son profil" on public.cod_profiles
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Aucune politique insert/update/delete ailleurs : seul le backend
-- (clé secrète, qui contourne RLS) écrit dans ces tables.

-- Droits par colonne : un joueur ne peut modifier QUE son identifiant
-- Activision et sa plateforme. Points, XP et badges sont hors de portée.
revoke insert, update, delete on public.cod_profiles from anon, authenticated;
grant update (activision_id, platform) on public.cod_profiles to authenticated;

-- Les fonctions qui écrivent ne sont exécutables que par le backend.
revoke execute on function public.cod_join_queue(uuid)                          from public, anon, authenticated;
revoke execute on function public.cod_try_create_match(integer, text[], text[]) from public, anon, authenticated;
revoke execute on function public.cod_finalize_match(uuid, text)                from public, anon, authenticated;
revoke execute on function public.cod_report_match(uuid, uuid, text)            from public, anon, authenticated;
revoke execute on function public.cod_confirm_match(uuid, uuid, boolean)        from public, anon, authenticated;
revoke execute on function public.cod_resolve_match(uuid, text)                 from public, anon, authenticated;
revoke execute on function public.cod_sweep_matches(integer, integer)           from public, anon, authenticated;
revoke execute on function public.cod_post_message(uuid, uuid, text)            from public, anon, authenticated;
revoke execute on function public.gta_register(uuid, uuid)                      from public, anon, authenticated;
revoke execute on function public.handle_auth_user_sync()                       from public, anon, authenticated;
revoke execute on function public.sync_cod_leaderboard()                        from public, anon, authenticated;
revoke execute on function public.sync_leaderboard_identity()                   from public, anon, authenticated;

grant execute on function public.cod_join_queue(uuid)                          to service_role;
grant execute on function public.cod_try_create_match(integer, text[], text[]) to service_role;
grant execute on function public.cod_finalize_match(uuid, text)                to service_role;
grant execute on function public.cod_report_match(uuid, uuid, text)            to service_role;
grant execute on function public.cod_confirm_match(uuid, uuid, boolean)        to service_role;
grant execute on function public.cod_resolve_match(uuid, text)                 to service_role;
grant execute on function public.cod_sweep_matches(integer, integer)           to service_role;
grant execute on function public.cod_post_message(uuid, uuid, text)            to service_role;
grant execute on function public.gta_register(uuid, uuid)                      to service_role;

-- Fonctions de lecture : publiques, comme les tables.
grant execute on function public.cod_active_match_id(uuid)      to anon, authenticated, service_role;
grant execute on function public.cod_matches_for(uuid, integer) to anon, authenticated, service_role;
grant execute on function public.cod_loss_penalty(integer)      to anon, authenticated, service_role;
grant execute on function public.is_admin()                     to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 5. TEMPS RÉEL
-- -----------------------------------------------------------------------------
-- Le classement, la page de match et son chat s'actualisent seuls (Supabase Realtime).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['cod_leaderboard', 'cod_matches', 'cod_match_messages', 'gta_registrations'] loop
      if not exists (
        select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
