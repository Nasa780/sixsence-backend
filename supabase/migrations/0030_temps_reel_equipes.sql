-- =============================================================================
-- 0030 : temps réel du mode « Match team »
-- =============================================================================
-- Feuille de match, tableau du tournoi et classement des équipes mis à jour en direct sur le site
-- (tables déjà en lecture publique). Idempotent.

do $$
declare
  t text;
begin
  foreach t in array array['team_matches', 'tournament_bracket', 'teams'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
