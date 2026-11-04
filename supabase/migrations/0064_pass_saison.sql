-- Pass de saison gratuit : l'XP de la saison = xp - pass_xp_base. L'XP n'étant pas remise à zéro à la clôture,
-- pass_reset_season() pose ce repère pour la saison suivante.
alter table public.cod_profiles add column if not exists pass_xp_base integer not null default 0;

create or replace function public.pass_reset_season()
returns void
language sql
security definer
set search_path = public
as $$
  update public.cod_profiles set pass_xp_base = xp where pass_xp_base is distinct from xp;
$$;
revoke all on function public.pass_reset_season() from public, anon, authenticated;
