-- 0049 : parcours des joueurs et play-in de la grande finale.
--   * team_memberships : passages des joueurs dans les équipes (arrivée, rôle, départ et motif), tenus à jour par
--     des déclencheurs sur team_members ; effectifs actuels repris à leur date d'arrivée. Les départs d'avant
--     cette migration ne sont pas connus (le site les reconstruit depuis les matchs). Équipes de Coupe Anubis exclues.
--   * tournaments.kind 'playin' : 7e et 8e du circuit contre les 2 meilleures de la Division (BO3), les 2 vainqueurs
--     prennent les dernières places du tournoi de fin de saison.

create table if not exists public.team_memberships (
  id          bigint generated always as identity primary key,
  team_id     uuid not null references public.teams (id) on delete cascade,
  user_id     uuid not null references public.users (id) on delete cascade,
  role        text not null default 'player',
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  left_reason text check (left_reason in ('left', 'disbanded'))
);
create index if not exists team_memberships_user_idx on public.team_memberships (user_id, joined_at desc);
create unique index if not exists team_memberships_open_idx on public.team_memberships (user_id) where left_at is null;

alter table public.team_memberships enable row level security;
drop policy if exists "team_memberships: lecture publique" on public.team_memberships;
create policy "team_memberships: lecture publique" on public.team_memberships for select to anon, authenticated using (true);

create or replace function public.team_membership_track()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.teams where id = new.team_id and cup_tournament is not null) then
      return new;
    end if;
    -- Un passage resté ouvert (ancienne équipe) est fermé avant d'ouvrir le nouveau.
    update public.team_memberships set left_at = now(), left_reason = 'left' where user_id = new.user_id and left_at is null;
    insert into public.team_memberships (team_id, user_id, role, joined_at) values (new.team_id, new.user_id, new.role, new.joined_at);
    return new;
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role then
      update public.team_memberships set role = new.role where user_id = new.user_id and team_id = new.team_id and left_at is null;
    end if;
    return new;
  else
    update public.team_memberships
       set left_at = now(),
           left_reason = case when exists (select 1 from public.teams where id = old.team_id and disbanded_at is not null) then 'disbanded' else 'left' end
     where user_id = old.user_id and team_id = old.team_id and left_at is null;
    return old;
  end if;
end;
$$;

drop trigger if exists team_members_track on public.team_members;
create trigger team_members_track after insert or update or delete on public.team_members
  for each row execute function public.team_membership_track();

-- Effectifs actuels (hors équipes de Coupe Anubis).
insert into public.team_memberships (team_id, user_id, role, joined_at)
select m.team_id, m.user_id, m.role, m.joined_at
  from public.team_members m
  join public.teams t on t.id = m.team_id
 where t.cup_tournament is null
   and not exists (select 1 from public.team_memberships x where x.user_id = m.user_id and x.left_at is null);

alter table public.tournaments drop constraint if exists tournaments_kind_check;
alter table public.tournaments add constraint tournaments_kind_check check (kind in ('saison', 'horus', 'anubis', 'playin'));
