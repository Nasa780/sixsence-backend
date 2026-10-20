-- =============================================================================
-- 0034 : Division — code de la partie privée donné par l'équipe hôte
-- =============================================================================
-- Table à part et privée (team_matches est lisible par tous) : lue et écrite par le backend,
-- montrée aux joueurs du match, aux Leaders des deux équipes et aux arbitres. L'hôte peut le
-- corriger tant qu'aucun score n'est déclaré. Sans code 10 min après la création du match,
-- l'autre équipe peut déclarer forfait (« hôte muet »).
create table if not exists public.team_match_codes (
  match_id   uuid primary key references public.team_matches (id) on delete cascade,
  code       text not null check (char_length(code) between 1 and 40),
  set_by     uuid references public.users (id) on delete set null,
  set_at     timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.team_match_codes enable row level security;
-- Aucune politique : privé.
