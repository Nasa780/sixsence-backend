-- =============================================================================
-- 0032 : classé en solo — plus de réduction de la défaite pour un joueur seul
-- =============================================================================
-- Les groupes sont coupés (COD_GROUPS) : tout le monde joue seul, la réduction de 25 % « joueur
-- seul » de 0016 disparaît. Le reste du barème Elo par équipe (0031) est inchangé.

create or replace function public.cod_points_preview(p_match uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m        public.cod_matches;
  v_result jsonb := '{}'::jsonb;
  r        record;
  v_played integer;
  v_placed boolean;
  v_total_a numeric;
  v_total_b numeric;
  v_size   integer;
  v_gap    numeric;
  v_chance numeric;
  v_win    integer;
begin
  select * into m from public.cod_matches where id = p_match;
  if not found then
    return null;
  end if;

  select coalesce(sum(points), 0) into v_total_a from public.cod_profiles where user_id = any (m.team_a);
  select coalesce(sum(points), 0) into v_total_b from public.cod_profiles where user_id = any (m.team_b);
  v_size := greatest(1, coalesce(m.team_size, array_length(m.team_a, 1), 1));

  for r in
    select p.user_id, p.points
      from public.cod_profiles p
     where p.user_id = any (m.team_a || m.team_b)
  loop
    select count(*) into v_played
      from public.cod_matches x
     where x.status = 'completed'
       and x.id <> m.id
       and x.season_id is not distinct from m.season_id
       and (x.team_a @> array[r.user_id] or x.team_b @> array[r.user_id]);
    v_placed := v_played < 10;

    -- Écart moyen par joueur, du point de vue de l'équipe du joueur.
    v_gap := case when r.user_id = any (m.team_a) then v_total_b - v_total_a else v_total_a - v_total_b end / v_size;
    v_chance := 1 / (1 + power(10::numeric, v_gap / 800));
    v_win := round(40 + 20 * (1 - v_chance))::integer;

    v_result := v_result || jsonb_build_object(
      r.user_id::text,
      jsonb_build_object(
        'win', case when v_placed then v_win * 2 else v_win end,
        'loss', least(r.points, round(public.cod_loss_penalty(r.points) * (0.7 + 0.6 * v_chance))::integer),
        'bonus', 0,
        'placement', case when v_placed then v_played + 1 else null end
      )
    );
  end loop;

  return v_result;
end;
$$;
