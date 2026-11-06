-- Score de manches lu sur la capture d'un match classé : affiché sur la carte de résultat Discord, même si la capture
-- a été envoyée avant la validation du match. Table privée, comme match_captures. Idempotent.

alter table public.match_captures add column if not exists rounds integer[];
