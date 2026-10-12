-- File : durée maximale de recherche.
--   confirmed_at : dernière confirmation de présence (entrée en file ou « Rester en file »).
--                  Distincte de joined_at, qui fixe l'ordre de passage : confirmer sa
--                  présence ne fait pas perdre sa place.
--   warned_at    : message « Toujours là ? » envoyé (5 min avant l'arrêt), sinon null.
-- Le backend arrête la recherche 30 min après confirmed_at (COD_QUEUE_MAX_MINUTES).
-- Idempotent.

alter table public.cod_queue add column if not exists confirmed_at timestamptz not null default now();
alter table public.cod_queue add column if not exists warned_at    timestamptz;
create index if not exists cod_queue_confirmed_idx on public.cod_queue (confirmed_at);
