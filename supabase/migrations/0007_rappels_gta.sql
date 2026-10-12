-- =============================================================================
-- SixSence — migration 0007 : rappels Discord des événements GTA 6
--   reminder_sent_at : date d'envoi du rappel « 1 h avant » (une seule fois par
--   événement ; remis à vide si l'horaire change).
-- À exécuter après 0006. Idempotent.
-- =============================================================================
alter table public.gta_events add column if not exists reminder_sent_at timestamptz;
create index if not exists gta_events_reminder_idx on public.gta_events (starts_at) where reminder_sent_at is null and status = 'published';
