-- 0050 : pendant la vérification « Prêt ? » (status ready_check), un match n'est plus lisible publiquement : la
-- composition des équipes ne se découvre qu'une fois tout le monde prêt (on ne peut plus refuser selon ses adversaires).
-- Le backend (clé secrète) lit toujours tout ; GET /cod/matches/:id masque les autres joueurs pendant le « Prêt ? ».

drop policy if exists "cod_matches: lecture publique" on public.cod_matches;
create policy "cod_matches: lecture publique" on public.cod_matches for select to anon, authenticated using (status <> 'ready_check');
