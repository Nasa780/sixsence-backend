-- =============================================================================
-- 0038 : Coupe Horus (coupes d'équipe à inscription libre, automatiques)
-- =============================================================================
-- Le moteur du tournoi de fin de saison (0028) sert aussi aux coupes :
--   * tournaments.kind : 'saison' (qualification par le classement) ou 'horus' (inscription libre) ;
--   * formats : matchs en BO1 ou BO3, finale en BO3 ou BO5, petite finale (bronze) ;
--   * 4 places possibles (petites coupes) ;
--   * cup_schedules : rendez-vous récurrents (jour, heure de Paris, format) créés par un admin ;
--     l'interrupteur général est app_state 'cups_auto' ('on' / 'off') ;
--   * team_point_bonuses : points de Division gagnés hors match (podium et participation), une ligne par
--     équipe et par coupe, lisible par tous (courbe « Performance ») ; team_add_bonus les applique.

-- Matchs en BO1 (coupes), BO3 et BO5.
alter table public.team_matches drop constraint if exists team_matches_best_of_check;
alter table public.team_matches add constraint team_matches_best_of_check check (best_of in (1, 3, 5));

alter table public.tournaments drop constraint if exists tournaments_size_check;
alter table public.tournaments add constraint tournaments_size_check check (size in (4, 8, 16, 32));

alter table public.tournaments add column if not exists kind text not null default 'saison';
alter table public.tournaments drop constraint if exists tournaments_kind_check;
alter table public.tournaments add constraint tournaments_kind_check check (kind in ('saison', 'horus'));
alter table public.tournaments add column if not exists best_of integer not null default 3;
alter table public.tournaments drop constraint if exists tournaments_best_of_check;
alter table public.tournaments add constraint tournaments_best_of_check check (best_of in (1, 3));
alter table public.tournaments add column if not exists final_best_of integer not null default 5;
alter table public.tournaments drop constraint if exists tournaments_final_best_of_check;
alter table public.tournaments add constraint tournaments_final_best_of_check check (final_best_of in (3, 5));
alter table public.tournaments add column if not exists third_place boolean not null default false;
alter table public.tournaments add column if not exists third_team uuid references public.teams (id);

-- Rendez-vous récurrents (une coupe par semaine pour commencer).
create table if not exists public.cup_schedules (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'horus' check (kind in ('horus')),
  name          text not null check (char_length(name) between 3 and 60),
  weekday       integer not null check (weekday between 0 and 6),
  start_time    time not null,
  size          integer not null check (size in (4, 8, 16)),
  best_of       integer not null check (best_of in (1, 3)),
  final_best_of integer not null check (final_best_of in (3, 5)),
  active        boolean not null default true,
  last_date     date,
  created_by    uuid references public.users (id) on delete set null,
  created_at    timestamptz not null default now()
);
alter table public.cup_schedules enable row level security;
-- Aucune politique : privé, géré par le backend (admin).

alter table public.tournaments add column if not exists schedule_id uuid references public.cup_schedules (id) on delete set null;

-- Points de Division gagnés en coupe (hors match).
create table if not exists public.team_point_bonuses (
  id            bigserial primary key,
  team_id       uuid not null references public.teams (id) on delete cascade,
  tournament_id uuid references public.tournaments (id) on delete set null,
  points        integer not null,
  reason        text not null,
  created_at    timestamptz not null default now(),
  unique (team_id, tournament_id)
);
alter table public.team_point_bonuses enable row level security;
drop policy if exists "team_point_bonuses: lecture publique" on public.team_point_bonuses;
create policy "team_point_bonuses: lecture publique" on public.team_point_bonuses for select to anon, authenticated using (true);

-- Ajoute un bonus une seule fois par équipe et par coupe (renvoie false s'il existait déjà).
create or replace function public.team_add_bonus(p_team uuid, p_tournament uuid, p_points integer, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.team_point_bonuses (team_id, tournament_id, points, reason) values (p_team, p_tournament, p_points, p_reason)
  on conflict (team_id, tournament_id) do nothing;
  if not found then
    return false;
  end if;
  update public.teams set points = points + p_points where id = p_team;
  return true;
end;
$$;
revoke all on function public.team_add_bonus(uuid, uuid, integer, text) from public, anon, authenticated;
