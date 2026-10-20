-- =============================================================================
-- 0036 : lien d'invitation d'équipe
-- =============================================================================
-- Un Leader partage un lien (code de 8 caractères) : le joueur qui l'ouvre rejoint l'équipe directement
-- (mêmes conditions qu'une invitation : conditions d'accès, 8 joueurs au plus, transferts ouverts).
-- Table à part et privée (teams est lisible par tous) ; le code peut être régénéré pour couper l'ancien lien.
create table if not exists public.team_invite_links (
  team_id    uuid primary key references public.teams (id) on delete cascade,
  code       text not null unique check (code ~ '^[a-z0-9]{8}$'),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.team_invite_links enable row level security;
-- Aucune politique : privé, lu et écrit par le backend.
