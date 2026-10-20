-- =============================================================================
-- 0035 : tags d'équipe avec minuscules
-- =============================================================================
-- Le tag accepte majuscules et minuscules (2 à 4 lettres ou chiffres, ex. « NxS ») et garde la casse
-- choisie. L'unicité ne tient pas compte de la casse : « Nxs » est refusé si « NXS » existe déjà.
alter table public.teams drop constraint if exists teams_tag_check;
alter table public.teams add constraint teams_tag_check check (tag ~ '^[A-Za-z0-9]{2,4}$');

drop index if exists public.teams_tag_active;
create unique index if not exists teams_tag_active_ci on public.teams (lower(tag)) where disbanded_at is null;

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
  if exists (select 1 from public.teams where disbanded_at is null and lower(tag) = lower(p_tag)) then
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

-- --- Logos et bannières : GIF animés acceptés (5 Mo au plus) -----------------------------------
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
 where id = 'team-media';
