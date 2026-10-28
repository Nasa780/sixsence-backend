-- 0053 : réglages relevés par l'analyse du site (avis de sécurité et de performance de Supabase).

-- Logos et bannières d'équipe : images fixes compressées en WebP par le site, GIF limités à 1 Mo (logo) et 2 Mo
-- (bannière) : le bucket passe de 5 à 2 Mo.
update storage.buckets set file_size_limit = 2097152 where id = 'team-media';

-- Fonction de déclencheur (historique des équipes, 0049) : rien à appeler depuis l'API.
revoke execute on function public.team_membership_track() from public, anon, authenticated;

-- search_path fixé (avis « Function Search Path Mutable »).
alter function public.team_match_stakes(integer, integer) set search_path = public;

-- auth.uid() évalué une seule fois par requête au lieu d'une fois par ligne (avis « Auth RLS Initialization Plan »).
drop policy if exists "cod_profiles: édition de son profil" on public.cod_profiles;
create policy "cod_profiles: édition de son profil" on public.cod_profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
