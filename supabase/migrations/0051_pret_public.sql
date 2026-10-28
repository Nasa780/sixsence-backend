-- 0051 : annule la 0050. Les matchs redeviennent lisibles publiquement pendant la vérification « Prêt ? » : le problème
-- venait de la fenêtre « Prêt ? » du site, transparente, qui laissait voir le tableau des équipes (corrigé côté site).

drop policy if exists "cod_matches: lecture publique" on public.cod_matches;
create policy "cod_matches: lecture publique" on public.cod_matches for select to anon, authenticated using (true);
