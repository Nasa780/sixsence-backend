-- 0052 : « Prêt ? » facultatif. À la fin du compte à rebours d'un match trouvé, le backend démarre le match pour tout le
-- monde (au lieu de l'annuler et de sanctionner les absents) quand COD_READY_REQUIRED n'est pas à « on ».

create or replace function public.cod_start_after_ready(p_match uuid)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
begin
  select * into m from public.cod_matches where id = p_match for update;
  if not found or m.status <> 'ready_check' then
    return m;
  end if;
  update public.cod_matches
     set ready_users = m.team_a || m.team_b, status = 'in_progress', started_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

revoke all on function public.cod_start_after_ready(uuid) from public, anon, authenticated;
grant execute on function public.cod_start_after_ready(uuid) to service_role;
