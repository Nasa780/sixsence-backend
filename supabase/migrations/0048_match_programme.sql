-- 0048 : match de Division programmé. Une équipe choisit un créneau (toutes les 15 min, jusqu'à 48 h) avec ses
-- joueurs ; 5 min avant, elle entre dans la file (servie en premier) : deux équipes du même créneau s'affrontent,
-- sinon la recherche continue normalement. Une programmation par équipe. Table privée (lue par le backend).

create table if not exists public.team_schedules (
  team_id    uuid primary key references public.teams (id) on delete cascade,
  roster     uuid[] not null,
  slot       timestamptz not null,
  created_by uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  reminded   boolean not null default false
);
create index if not exists team_schedules_slot_idx on public.team_schedules (slot);

alter table public.team_schedules enable row level security;
