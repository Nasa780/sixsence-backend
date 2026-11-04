-- Rappels de coupe demandés avec /rappel sur Discord : message privé à l'ouverture du check-in.
-- Table privée : lue et écrite par le backend seulement.
create table if not exists public.cup_reminders (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (tournament_id, user_id)
);
create index if not exists cup_reminders_pending_idx on public.cup_reminders (tournament_id) where sent_at is null;
alter table public.cup_reminders enable row level security;
revoke all on table public.cup_reminders from public, anon, authenticated;
