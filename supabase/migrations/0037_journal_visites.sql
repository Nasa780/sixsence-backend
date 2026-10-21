-- =============================================================================
-- 0037 : journal du site (visiteurs du jour, bilan quotidien sur Discord)
-- =============================================================================
-- Un visiteur = l'identifiant aléatoire gardé dans son navigateur (le même que le compteur
-- « En ligne ») : aucune donnée personnelle. Une ligne par visiteur et par jour (heure de Paris),
-- gardée 90 jours. Table privée, lue et écrite par le backend.
create table if not exists public.site_visits (
  day     date not null,
  visitor text not null check (visitor ~ '^[A-Za-z0-9-]{8,64}$'),
  primary key (day, visitor)
);
alter table public.site_visits enable row level security;
-- Aucune politique : privé.

-- Bilan d'une journée (heure de Paris) pour le salon des journaux.
create or replace function public.site_daily_report(p_day date)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'visitors', (select count(*) from public.site_visits where day = p_day),
    'signups', (select count(*) from public.users where (created_at at time zone 'Europe/Paris')::date = p_day),
    'teams', (select count(*) from public.teams where (created_at at time zone 'Europe/Paris')::date = p_day),
    'ranked', (select count(*) from public.cod_matches where (created_at at time zone 'Europe/Paris')::date = p_day),
    'division', (select count(*) from public.team_matches where (created_at at time zone 'Europe/Paris')::date = p_day)
  );
$$;
revoke all on function public.site_daily_report(date) from public, anon, authenticated;
