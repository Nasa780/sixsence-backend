-- =============================================================================
-- SixSence — migration 0008 : notifications push (appli installée, site fermé)
--   push_subscriptions : abonnements des navigateurs / téléphones d'un joueur
--   app_secrets        : clés VAPID générées par le serveur au premier démarrage
-- Tables privées : lues et écrites par le backend uniquement.
-- À exécuter après 0007. Idempotent.
-- =============================================================================

create table if not exists public.push_subscriptions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.users (id) on delete cascade,
  endpoint     text not null unique check (char_length(endpoint) <= 1000),
  p256dh       text not null check (char_length(p256dh) <= 200),
  auth         text not null check (char_length(auth) <= 100),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table if not exists public.app_secrets (
  key        text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
alter table public.app_secrets        enable row level security;
-- Aucune politique : ni lecture ni écriture publiques (la clé secrète du backend contourne RLS).
