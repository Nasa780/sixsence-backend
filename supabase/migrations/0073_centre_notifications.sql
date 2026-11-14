-- Centre de notifications du site (cloche du menu) : copie de chaque notification envoyée à un joueur
-- (match trouvé, résultats, équipe, coupes, cartes, GTA…), qu'il ait ou non activé les notifications push.
-- Une notification de même tag remplace la précédente. Gardées 30 jours (ménage par le backend).
-- Table privée : lue et écrite par le backend seulement.
create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  category text,
  title text not null,
  body text not null,
  url text not null,
  tag text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists notifications_user_created on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread on public.notifications (user_id) where read_at is null;
create index if not exists notifications_created on public.notifications (created_at);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
