-- Tournois (refonte, étape 3) : BO du tableau des perdants et messages de l'organisation.
--   * tournaments.losers_best_of / cup_schedules.losers_best_of : BO des matchs du tableau des perdants (double
--     élimination), null = même BO que les autres matchs ;
--   * tournament_messages : messages de l'équipe SixSence affichés sur la fiche d'une coupe (lecture publique,
--     écriture par le backend).

alter table public.tournaments add column if not exists losers_best_of integer check (losers_best_of in (1, 3));
alter table public.cup_schedules add column if not exists losers_best_of integer check (losers_best_of in (1, 3));

create table if not exists public.tournament_messages (
  id            bigserial primary key,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  author_id     uuid references public.users (id) on delete set null,
  body          text not null check (char_length(body) between 1 and 1000),
  created_at    timestamptz not null default now()
);
create index if not exists tournament_messages_tournament on public.tournament_messages (tournament_id, created_at desc);
alter table public.tournament_messages enable row level security;
drop policy if exists "tournament_messages: lecture publique" on public.tournament_messages;
create policy "tournament_messages: lecture publique" on public.tournament_messages for select to anon, authenticated using (true);
