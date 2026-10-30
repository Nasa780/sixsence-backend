-- Coupes : places de remplaçant.
-- Une Coupe Horus accepte quelques équipes de plus que ses places (reserveTeams de tournamentPolicy.ts), dans l'ordre
-- d'inscription (seed). Au tirage, les équipes présentes au check-in prennent les places dans cet ordre : une équipe
-- titulaire absente laisse sa place au premier remplaçant présent. Les remplaçants présents mais pas retenus (toutes les
-- titulaires étaient là) sont marqués bench : ils ne jouent pas et ne sont pas forfait.
-- Coupe Anubis : pas de colonne, les joueurs inscrits en plus (cup_players, ordre registered_at) restent sans équipe.

alter table public.tournament_teams add column if not exists bench boolean not null default false;
