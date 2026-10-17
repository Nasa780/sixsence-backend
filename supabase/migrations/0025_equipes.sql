-- =============================================================================
-- 0025 : équipes (mode « Match team », étape 1)
-- =============================================================================
--   * teams : fiche d'équipe (nom et tag uniques, apparence, points du classement des équipes) ;
--     owner_id = créateur (couronne), Leader d'office ; dissoute = disbanded_at (fiche conservée) ;
--   * team_members : un joueur appartient au plus à une équipe (clé primaire user_id),
--     8 joueurs au plus dont 4 titulaires ; rôle « leader » ou « player » ;
--   * team_invites : invitations (envoyées par un Leader) et candidatures (envoyées par le joueur) ;
--   * team_reports : signalements d'équipe (nom, logo, bannière…) ;
--   * cod_profiles.team_left_at : départ d'une équipe (24 h avant d'en rejoindre une autre) ;
--   * bucket « team-media » (logos, bannières), envoi dans <user_id>/… par le joueur connecté.
-- Lecture publique des équipes et des effectifs ; écritures uniquement par le backend.

create table if not exists public.teams (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 3 and 24),
  tag          text not null check (tag ~ '^[A-Z0-9]{2,4}$'),
  description  text check (char_length(description) <= 300),
  color        text not null default '#d4af37' check (color ~ '^#[0-9a-f]{6}$'),
  logo_url     text,
  banner_url   text,
  socials      jsonb not null default '{}'::jsonb,
  owner_id     uuid not null references public.users (id),
  points       integer not null default 1000,
  wins         integer not null default 0,
  losses       integer not null default 0,
  created_at   timestamptz not null default now(),
  disbanded_at timestamptz
);
-- Nom et tag uniques parmi les équipes actives (une équipe dissoute libère les siens).
create unique index if not exists teams_name_active on public.teams (lower(name)) where disbanded_at is null;
create unique index if not exists teams_tag_active on public.teams (tag) where disbanded_at is null;
create index if not exists teams_points on public.teams (points desc) where disbanded_at is null;

create table if not exists public.team_members (
  user_id   uuid primary key references public.users (id) on delete cascade,
  team_id   uuid not null references public.teams (id) on delete cascade,
  role      text not null default 'player' check (role in ('leader', 'player')),
  starter   boolean not null default false,
  joined_at timestamptz not null default now()
);
create index if not exists team_members_team on public.team_members (team_id);

create table if not exists public.team_invites (
  id          bigint generated always as identity primary key,
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  kind        text not null check (kind in ('invite', 'request')),
  created_by  uuid not null references public.users (id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);
create unique index if not exists team_invites_pending on public.team_invites (team_id, user_id) where status = 'pending';
create index if not exists team_invites_user on public.team_invites (user_id) where status = 'pending';

create table if not exists public.team_reports (
  id          bigint generated always as identity primary key,
  team_id     uuid not null references public.teams (id) on delete cascade,
  reporter_id uuid not null references public.users (id) on delete cascade,
  reason      text not null check (reason in ('name', 'logo', 'banner', 'description', 'other')),
  details     text check (char_length(details) <= 500),
  status      text not null default 'open' check (status in ('open', 'resolved', 'rejected')),
  resolved_by uuid references public.users (id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

alter table public.cod_profiles add column if not exists team_left_at timestamptz;

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.team_reports enable row level security;

drop policy if exists "teams: lecture publique" on public.teams;
create policy "teams: lecture publique" on public.teams for select to anon, authenticated using (true);
drop policy if exists "team_members: lecture publique" on public.team_members;
create policy "team_members: lecture publique" on public.team_members for select to anon, authenticated using (true);
-- team_invites et team_reports : aucune politique, lus et écrits par le backend seulement.

-- --- Fonctions atomiques ----------------------------------------------------------

-- Crée une équipe : le créateur en devient le Leader (couronne) et le 1er titulaire.
create or replace function public.team_create(p_owner uuid, p_name text, p_tag text, p_description text, p_color text)
returns public.teams
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.teams;
begin
  if exists (select 1 from public.team_members where user_id = p_owner) then
    raise exception 'ALREADY_IN_TEAM';
  end if;
  if exists (select 1 from public.teams where disbanded_at is null and lower(name) = lower(p_name)) then
    raise exception 'TEAM_NAME_TAKEN';
  end if;
  if exists (select 1 from public.teams where disbanded_at is null and tag = p_tag) then
    raise exception 'TEAM_TAG_TAKEN';
  end if;
  insert into public.teams (name, tag, description, color, owner_id)
  values (p_name, p_tag, p_description, p_color, p_owner)
  returning * into t;
  insert into public.team_members (user_id, team_id, role, starter) values (p_owner, t.id, 'leader', true);
  -- Ses candidatures en attente n'ont plus lieu d'être.
  update public.team_invites set status = 'cancelled', answered_at = now() where user_id = p_owner and status = 'pending';
  return t;
end;
$$;

-- Ajoute un joueur (invitation ou candidature acceptée) : 8 joueurs au plus, titulaire s'il reste
-- une place parmi les 4.
create or replace function public.team_add_member(p_team uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t         public.teams;
  v_count   integer;
  v_starter integer;
begin
  select * into t from public.teams where id = p_team for update;
  if not found or t.disbanded_at is not null then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  if exists (select 1 from public.team_members where user_id = p_user) then
    raise exception 'ALREADY_IN_TEAM';
  end if;
  select count(*), count(*) filter (where starter) into v_count, v_starter from public.team_members where team_id = p_team;
  if v_count >= 8 then
    raise exception 'TEAM_FULL';
  end if;
  insert into public.team_members (user_id, team_id, role, starter) values (p_user, p_team, 'player', v_starter < 4);
  update public.team_invites set status = 'cancelled', answered_at = now() where user_id = p_user and status = 'pending';
end;
$$;

-- Retire un joueur (départ ou exclusion). p_left : départ volontaire, compté pour le délai de 24 h.
-- Le Leader à la couronne ne peut pas partir sans la transmettre, sauf s'il est seul (équipe dissoute).
create or replace function public.team_remove_member(p_team uuid, p_user uuid, p_left boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t       public.teams;
  v_count integer;
begin
  select * into t from public.teams where id = p_team for update;
  if not found or t.disbanded_at is not null then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  if not exists (select 1 from public.team_members where team_id = p_team and user_id = p_user) then
    raise exception 'NOT_IN_TEAM';
  end if;
  select count(*) into v_count from public.team_members where team_id = p_team;
  if t.owner_id = p_user then
    if v_count > 1 then
      raise exception 'OWNER_MUST_TRANSFER';
    end if;
    update public.teams set disbanded_at = now() where id = p_team;
    update public.team_invites set status = 'cancelled', answered_at = now() where team_id = p_team and status = 'pending';
  end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
  if p_left then
    update public.cod_profiles set team_left_at = now() where user_id = p_user;
  end if;
end;
$$;

-- Transmet la couronne à un membre de l'équipe (qui devient Leader).
create or replace function public.team_transfer(p_team uuid, p_owner uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.teams;
begin
  select * into t from public.teams where id = p_team for update;
  if not found or t.disbanded_at is not null then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  if t.owner_id <> p_owner then
    raise exception 'NOT_TEAM_OWNER';
  end if;
  if p_target = p_owner or not exists (select 1 from public.team_members where team_id = p_team and user_id = p_target) then
    raise exception 'NOT_IN_TEAM';
  end if;
  update public.teams set owner_id = p_target where id = p_team;
  update public.team_members set role = 'leader' where team_id = p_team and user_id = p_target;
end;
$$;

-- Dissout une équipe : fiche conservée (historique), effectif libéré sans délai, invitations annulées.
create or replace function public.team_disband(p_team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.teams set disbanded_at = now() where id = p_team and disbanded_at is null;
  if not found then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  delete from public.team_members where team_id = p_team;
  update public.team_invites set status = 'cancelled', answered_at = now() where team_id = p_team and status = 'pending';
end;
$$;

-- Titulaire ou remplaçant : 4 titulaires au plus.
create or replace function public.team_set_starter(p_team uuid, p_user uuid, p_starter boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.teams where id = p_team and disbanded_at is null for update;
  if not found then
    raise exception 'TEAM_NOT_FOUND';
  end if;
  if not exists (select 1 from public.team_members where team_id = p_team and user_id = p_user) then
    raise exception 'NOT_IN_TEAM';
  end if;
  if p_starter and (select count(*) from public.team_members where team_id = p_team and starter and user_id <> p_user) >= 4 then
    raise exception 'STARTERS_FULL';
  end if;
  update public.team_members set starter = p_starter where team_id = p_team and user_id = p_user;
end;
$$;

revoke execute on function public.team_create(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.team_add_member(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.team_remove_member(uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.team_transfer(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.team_disband(uuid) from public, anon, authenticated;
revoke execute on function public.team_set_starter(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.team_create(uuid, text, text, text, text) to service_role;
grant execute on function public.team_add_member(uuid, uuid) to service_role;
grant execute on function public.team_remove_member(uuid, uuid, boolean) to service_role;
grant execute on function public.team_transfer(uuid, uuid, uuid) to service_role;
grant execute on function public.team_disband(uuid) to service_role;
grant execute on function public.team_set_starter(uuid, uuid, boolean) to service_role;

-- --- Logos et bannières -----------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-media', 'team-media', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "team-media: envoi dans son dossier" on storage.objects;
create policy "team-media: envoi dans son dossier" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'team-media' and (storage.foldername(name))[1] = auth.uid()::text);
