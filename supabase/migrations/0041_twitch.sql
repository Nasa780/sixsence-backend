-- =============================================================================
-- 0041 : chaîne Twitch sur le profil
-- =============================================================================
-- cod_profiles.twitch : identifiant de la chaîne (4 à 25 lettres, chiffres ou _), modifiable par le joueur
-- lui-même comme son identifiant Activision (droit de mise à jour sur la colonne).

alter table public.cod_profiles add column if not exists twitch text;
alter table public.cod_profiles drop constraint if exists cod_profiles_twitch_check;
alter table public.cod_profiles add constraint cod_profiles_twitch_check check (twitch is null or twitch ~ '^[A-Za-z0-9_]{4,25}$');
grant update (twitch) on public.cod_profiles to authenticated;
