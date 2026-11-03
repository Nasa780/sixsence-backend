-- Préférences de notification de chaque joueur : catégories coupées en notification (push_off) et en message
-- privé Discord (dm_off). Absent ou liste vide = tout reçu. Table privée : lue et écrite par le backend seulement.
create table if not exists public.notification_prefs (
  user_id uuid primary key references public.users (id) on delete cascade,
  push_off text[] not null default '{}',
  dm_off text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;
revoke all on public.notification_prefs from anon, authenticated;
