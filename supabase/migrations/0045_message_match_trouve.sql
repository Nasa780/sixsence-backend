-- =============================================================================
-- 0045 : message privé Discord « Match trouvé » mis à jour en direct
-- =============================================================================
-- Pour chaque joueur du match : « salon:message » du message privé, modifié à chaque étape
-- (prêt, c'est parti, annulé) au lieu d'envoyer de nouveaux messages.
alter table public.cod_matches add column if not exists discord_dm jsonb not null default '{}'::jsonb;
