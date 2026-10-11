-- =============================================================================
-- SixSence — migration 0003
--   Un identifiant Activision ne peut appartenir qu'à un seul compte
--   (contre les comptes multiples). Comparaison sans tenir compte des
--   majuscules ni des espaces autour. À exécuter après 0002. Idempotent.
-- =============================================================================

-- Nettoyage à l'écriture : espaces retirés, chaîne vide = pas d'identifiant.
create or replace function public.cod_profiles_clean_activision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.activision_id := nullif(btrim(new.activision_id), '');
  return new;
end;
$$;

drop trigger if exists cod_profiles_clean_activision on public.cod_profiles;
create trigger cod_profiles_clean_activision
  before insert or update of activision_id on public.cod_profiles
  for each row execute function public.cod_profiles_clean_activision();

update public.cod_profiles
   set activision_id = nullif(btrim(activision_id), '')
 where activision_id is distinct from nullif(btrim(activision_id), '');

-- Unicité (le site affiche un message clair en cas de doublon, code 23505).
create unique index if not exists cod_profiles_activision_unique
  on public.cod_profiles (lower(activision_id))
  where activision_id is not null;
