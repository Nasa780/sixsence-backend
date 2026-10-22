-- =============================================================================
-- 0044 : tickets Discord, motif « Autre » (motif écrit par le membre, gardé dans subject)
-- =============================================================================
alter table public.discord_tickets drop constraint if exists discord_tickets_motif_check;
alter table public.discord_tickets add constraint discord_tickets_motif_check
  check (motif in ('contestation', 'question', 'signalement', 'bug', 'autre'));
