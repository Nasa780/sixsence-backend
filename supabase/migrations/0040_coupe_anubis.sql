-- =============================================================================
-- 0040 : Coupe Anubis (inscription individuelle, équipes formées au hasard)
-- =============================================================================
--   * tournaments.kind / cup_schedules.kind : 'anubis' en plus ; team_size = joueurs par équipe ;
--   * cup_players : joueurs inscrits (check-in individuel, équipe formée au début) ;
--   * teams.cup_tournament : équipe temporaire d'une Coupe Anubis (créée dissoute : jamais au classement,
--     ni dans les recherches, nom et tag libres) ; tournament_teams.captain : capitaine de l'équipe formée ;
--   * cup_medals : médailles or / argent / bronze des joueurs (profil).

alter table public.tournaments drop constraint if exists tournaments_kind_check;
alter table public.tournaments add constraint tournaments_kind_check check (kind in ('saison', 'horus', 'anubis'));
alter table public.tournaments add column if not exists team_size integer check (team_size between 1 and 5);

alter table public.cup_schedules drop constraint if exists cup_schedules_kind_check;
alter table public.cup_schedules add constraint cup_schedules_kind_check check (kind in ('horus', 'anubis'));
alter table public.cup_schedules add column if not exists team_size integer check (team_size between 1 and 5);

alter table public.teams add column if not exists cup_tournament uuid references public.tournaments (id) on delete set null;
alter table public.tournament_teams add column if not exists captain uuid references public.users (id);

create table if not exists public.cup_players (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id       uuid not null references public.users (id) on delete cascade,
  registered_at timestamptz not null default now(),
  checked_in_at timestamptz,
  team_id       uuid references public.teams (id),
  primary key (tournament_id, user_id)
);
alter table public.cup_players enable row level security;
drop policy if exists "cup_players: lecture publique" on public.cup_players;
create policy "cup_players: lecture publique" on public.cup_players for select to anon, authenticated using (true);

create table if not exists public.cup_medals (
  id            bigserial primary key,
  user_id       uuid not null references public.users (id) on delete cascade,
  tournament_id uuid references public.tournaments (id) on delete set null,
  place         text not null check (place in ('or', 'argent', 'bronze')),
  name          text not null,
  team_name     text,
  created_at    timestamptz not null default now(),
  unique (user_id, tournament_id)
);
create index if not exists cup_medals_user on public.cup_medals (user_id);
alter table public.cup_medals enable row level security;
drop policy if exists "cup_medals: lecture publique" on public.cup_medals;
create policy "cup_medals: lecture publique" on public.cup_medals for select to anon, authenticated using (true);
