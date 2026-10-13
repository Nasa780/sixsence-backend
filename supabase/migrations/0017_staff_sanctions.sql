-- -----------------------------------------------------------------------------
-- SixSence — migration 0017 : rôles staff et arbitre, sanctions manuelles
-- -----------------------------------------------------------------------------
-- Rôles :
--   admin   : tout (gestion du site, rôles, événements, saison…)
--   staff   : contestations, demandes d'arbitrage, signalements et sanctions
--   arbitre : contestations et demandes d'arbitrage uniquement
-- Sanctions (cod_sanctions, privées) données par l'admin ou le staff :
--   warning   avertissement (historique)
--   temp_ban  exclusion temporaire de la file classée (durée en minutes)
--   perm_ban  exclusion définitive du classé (jusqu'à levée)
--   points    retrait de points
-- Chaque sanction peut être levée : l'exclusion est recalculée, les points rendus.
-- Idempotent.

alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check check (role in ('member', 'arbitre', 'staff', 'admin'));

-- Équipe de modération (admin, staff, arbitre) : lecture du chat et des preuves des matchs.
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.users where id = (select auth.uid()) and role in ('admin', 'staff', 'arbitre'));
$$;
grant execute on function public.is_moderator() to authenticated, service_role;

drop policy if exists "cod_match_messages: joueurs du match et admins" on public.cod_match_messages;
create policy "cod_match_messages: joueurs du match et admins" on public.cod_match_messages
  for select to authenticated
  using (
    public.is_moderator()
    or exists (
      select 1 from public.cod_matches m
       where m.id = match_id
         and (m.team_a @> array[(select auth.uid())] or m.team_b @> array[(select auth.uid())])
    )
  );

drop policy if exists "cod_match_proofs: joueurs du match et admins" on public.cod_match_proofs;
create policy "cod_match_proofs: joueurs du match et admins" on public.cod_match_proofs
  for select to authenticated
  using (
    public.is_moderator()
    or exists (
      select 1 from public.cod_matches m
       where m.id = match_id
         and (m.team_a @> array[(select auth.uid())] or m.team_b @> array[(select auth.uid())])
    )
  );

create table if not exists public.cod_sanctions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.users (id) on delete cascade,
  type         text not null check (type in ('warning', 'temp_ban', 'perm_ban', 'points')),
  reason       text not null check (char_length(reason) between 1 and 500),
  minutes      integer check (minutes between 1 and 525600),
  points       integer check (points between 0 and 5000),
  ends_at      timestamptz,
  report_id    bigint,
  created_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  lifted_at    timestamptz,
  lifted_by    uuid references public.users (id) on delete set null,
  lift_reason  text check (lift_reason is null or char_length(lift_reason) <= 500)
);
create index if not exists cod_sanctions_user_idx on public.cod_sanctions (user_id, created_at desc);
alter table public.cod_sanctions enable row level security; -- privée : lue et écrite par le backend uniquement

/** Date de fin d'une exclusion définitive (comparable et lisible partout). */
create or replace function public.cod_permanent_ban_until()
returns timestamptz
language sql
immutable
set search_path = public
as $$ select '9999-12-31 00:00:00+00'::timestamptz $$;

-- Exclusion de la file recalculée à partir des sanctions actives (exclusions non levées).
create or replace function public.cod_refresh_ban(p_user uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_until timestamptz;
begin
  select max(ends_at) into v_until
    from public.cod_sanctions
   where user_id = p_user
     and type in ('temp_ban', 'perm_ban')
     and lifted_at is null
     and ends_at > now();
  update public.cod_profiles set banned_until = v_until where user_id = p_user;
  return v_until;
end;
$$;

create or replace function public.cod_apply_sanction(
  p_user    uuid,
  p_type    text,
  p_reason  text,
  p_minutes integer,
  p_points  integer,
  p_by      uuid,
  p_report  bigint
)
returns public.cod_sanctions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason  text := trim(coalesce(p_reason, ''));
  v_ends    timestamptz;
  v_removed integer;
  s         public.cod_sanctions;
begin
  if p_type not in ('warning', 'temp_ban', 'perm_ban', 'points') then
    raise exception 'INVALID_SANCTION';
  end if;
  if v_reason = '' or char_length(v_reason) > 500 then
    raise exception 'INVALID_REASON';
  end if;
  if not exists (select 1 from public.cod_profiles where user_id = p_user) then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  if p_type = 'temp_ban' then
    if p_minutes is null or p_minutes < 1 or p_minutes > 525600 then
      raise exception 'INVALID_DURATION';
    end if;
    v_ends := now() + make_interval(mins => p_minutes);
    update public.cod_profiles set banned_until = greatest(coalesce(banned_until, now()), v_ends) where user_id = p_user;
  elsif p_type = 'perm_ban' then
    v_ends := public.cod_permanent_ban_until();
    update public.cod_profiles set banned_until = v_ends where user_id = p_user;
  elsif p_type = 'points' then
    if p_points is null or p_points < 1 or p_points > 5000 then
      raise exception 'INVALID_POINTS';
    end if;
    -- Points réellement retirés (jamais sous 0) : ce sont eux qui seront rendus en cas de levée.
    select least(points, p_points) into v_removed from public.cod_profiles where user_id = p_user for update;
    update public.cod_profiles set points = points - v_removed where user_id = p_user;
  end if;

  insert into public.cod_sanctions (user_id, type, reason, minutes, points, ends_at, report_id, created_by)
  values (
    p_user, p_type, v_reason,
    case when p_type = 'temp_ban' then p_minutes end,
    case when p_type = 'points' then v_removed end,
    v_ends, p_report, p_by
  )
  returning * into s;
  return s;
end;
$$;

create or replace function public.cod_lift_sanction(p_id bigint, p_by uuid, p_reason text)
returns public.cod_sanctions
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.cod_sanctions;
begin
  select * into s from public.cod_sanctions where id = p_id for update;
  if not found then
    raise exception 'SANCTION_NOT_FOUND';
  end if;
  if s.lifted_at is not null then
    raise exception 'SANCTION_LIFTED';
  end if;

  update public.cod_sanctions
     set lifted_at = now(), lifted_by = p_by, lift_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_id
  returning * into s;

  if s.type in ('temp_ban', 'perm_ban') then
    perform public.cod_refresh_ban(s.user_id);
  elsif s.type = 'points' and coalesce(s.points, 0) > 0 then
    update public.cod_profiles set points = points + s.points where user_id = s.user_id;
  end if;
  return s;
end;
$$;

revoke all on function public.cod_apply_sanction(uuid, text, text, integer, integer, uuid, bigint) from public, anon, authenticated;
revoke all on function public.cod_lift_sanction(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.cod_refresh_ban(uuid) from public, anon, authenticated;
grant execute on function public.cod_apply_sanction(uuid, text, text, integer, integer, uuid, bigint) to service_role;
grant execute on function public.cod_lift_sanction(bigint, uuid, text) to service_role;
grant execute on function public.cod_refresh_ban(uuid) to service_role;
