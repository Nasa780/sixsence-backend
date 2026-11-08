-- 0072 : droits minimaux pour les rôles publics de l'API (anon = visiteur, authenticated = joueur connecté).
--
-- Toutes les écritures passent par le serveur (clé service_role) et les fonctions SQL. La protection par ligne (RLS)
-- bloquait déjà toute écriture, mais les droits d'écriture accordés par défaut restaient en place : une règle RLS
-- ajoutée par erreur un jour aurait suffi à ouvrir une table (par exemple users.role). On les retire, pour que la
-- base reste fermée même en cas d'erreur de règle.
--
-- Seule écriture directe du site : un joueur modifie son identifiant Activision, sa plateforme et sa chaîne Twitch
-- (cod_profiles, règle RLS « édition de son profil »).
-- Les lectures (select) ne changent pas. Idempotente.

-- 1. Tables : plus aucune écriture pour les visiteurs et les joueurs connectés.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;

-- 2. La seule écriture directe autorisée, colonne par colonne.
grant update (activision_id, platform, twitch) on public.cod_profiles to authenticated;

-- 3. Séquences : pas d'écriture non plus (les insertions passent par le serveur).
revoke usage, update on all sequences in schema public from anon, authenticated;

-- 4. Fonction à droits élevés que seul le serveur appelle.
--    (is_admin et is_moderator restent appelables : les règles RLS et Storage s'en servent, elles ne renvoient qu'un booléen.)
revoke execute on function public.cod_points_preview(uuid) from anon, authenticated, public;

-- 5. Tables, séquences et fonctions créées plus tard par les migrations : mêmes droits minimaux par défaut.
--    Une nouvelle fonction appelée par le site (comme cod_matches_for) doit recevoir un grant execute explicite.
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, update on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, public;
