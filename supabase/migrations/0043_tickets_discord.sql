-- =============================================================================
-- 0043 : tickets Discord (contestation, question, signalement, bug)
-- =============================================================================
-- Un ticket = un salon privé créé par le bot entre un membre et l'équipe (Staff 6, Arbitre 6).
-- Numéro lisible (#0042), un ticket ouvert par membre. Table privée, lue et écrite par le backend.
create table if not exists public.discord_tickets (
  id          bigint generated always as identity primary key,
  discord_id  text not null,
  user_id     uuid references public.users (id) on delete set null,
  username    text,
  motif       text not null check (motif in ('contestation', 'question', 'signalement', 'bug')),
  subject     text,
  channel_id  text,
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  closed_by   text
);
create unique index if not exists discord_tickets_one_open on public.discord_tickets (discord_id) where status = 'open';
create index if not exists discord_tickets_channel on public.discord_tickets (channel_id);
alter table public.discord_tickets enable row level security;
-- Aucune politique : privé.
