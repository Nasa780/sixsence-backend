-- =============================================================================
-- 0039 : Coupe Horus en double élimination
-- =============================================================================
-- tournaments.bracket / cup_schedules.bracket : 'single' (élimination directe avec petite finale) ou
-- 'double' (tableau des gagnants, tableau des perdants, grande finale en un seul match ; bronze au perdant
-- de la finale des perdants). Tours du tableau des perdants numérotés 101, 102…, grande finale 200.

alter table public.tournaments add column if not exists bracket text not null default 'single';
alter table public.tournaments drop constraint if exists tournaments_bracket_check;
alter table public.tournaments add constraint tournaments_bracket_check check (bracket in ('single', 'double'));

alter table public.cup_schedules add column if not exists bracket text not null default 'single';
alter table public.cup_schedules drop constraint if exists cup_schedules_bracket_check;
alter table public.cup_schedules add constraint cup_schedules_bracket_check check (bracket in ('single', 'double'));
