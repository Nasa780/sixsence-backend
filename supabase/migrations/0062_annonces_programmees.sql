-- Annonces Discord programmées depuis l'admin : publiées toutes seules à l'heure choisie.
-- Table privée : lue et écrite par le backend seulement (/admin/discord/scheduled).
create table if not exists public.scheduled_announcements (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('annonce', 'nouveautes')),
  title text not null check (char_length(title) between 3 and 120),
  body text not null check (char_length(body) between 3 and 3500),
  url text,
  post_at timestamptz not null,
  -- pending : à publier ; sending : réservée par le serveur (jamais publiée deux fois) ; posted ; failed ; cancelled.
  status text not null default 'pending' check (status in ('pending', 'sending', 'posted', 'failed', 'cancelled')),
  error text,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  posted_at timestamptz
);
create index if not exists scheduled_announcements_due_idx on public.scheduled_announcements (post_at) where status = 'pending';
alter table public.scheduled_announcements enable row level security;
revoke all on table public.scheduled_announcements from public, anon, authenticated;
