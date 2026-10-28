-- 0052 : « Prêt automatique ». Option du joueur (page de la file) : quand un match est trouvé pour lui, son « Prêt ? »
-- est accepté tout seul par le serveur, même site fermé. Modifiée par le backend (POST /cod/auto-ready).

alter table public.cod_profiles add column if not exists auto_ready boolean not null default false;
