-- -----------------------------------------------------------------------------
-- SixSence — migration 0019 : cartes de visite
-- -----------------------------------------------------------------------------
--   * cod_cards : cartes obtenues par chaque joueur (définitives, sauf Partenaire et
--     Staff 6 qui suivent le badge ou le rôle). Privée : lue et écrite par le backend.
--     seen_at null = carte « Nouvelle » (pas encore vue dans la fenêtre de choix).
--   * cod_profiles.calling_card : carte équipée (fond du profil), lisible par tous,
--     modifiable seulement par le backend (aucun droit de mise à jour pour les joueurs).
-- Idempotent.

alter table public.cod_profiles add column if not exists calling_card text not null default 'sixsence';

create table if not exists public.cod_cards (
  user_id     uuid not null references public.users (id) on delete cascade,
  card_key    text not null check (char_length(card_key) between 1 and 60),
  obtained_at timestamptz not null default now(),
  seen_at     timestamptz,
  primary key (user_id, card_key)
);
alter table public.cod_cards enable row level security; -- privée : backend uniquement
