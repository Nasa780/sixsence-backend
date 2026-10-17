-- =============================================================================
-- 0031 : points du classé selon le niveau des deux équipes (Elo par équipe)
-- =============================================================================
-- Niveau d'une équipe = total des points de ses joueurs. Écart = (total adverse − total de
-- l'équipe) / nombre de joueurs par équipe (même échelle du 2v2 au 5v5). Chance de victoire
-- façon Elo : E = 1 / (1 + 10^(écart / 400)).
--   * victoire : 40 + 20 × (1 − E) → +50 à niveau égal, jusqu'à +60 contre une équipe bien plus
--     forte, +40 contre une équipe bien plus faible ; même gain pour toute l'équipe ;
--     placement (10 premiers matchs de la saison) : victoire doublée (+80 à +120) ;
--   * défaite : perte du rang du joueur (cod_loss_penalty, Bronze -15 … Maître et au-delà -50)
--     × (0,7 + 0,6 × E) → jusqu'à 30 % de moins contre plus fort, 30 % de plus contre plus faible ;
--     -25 % pour un joueur seul ; jamais sous 0.
-- Les enjeux sont calculés à la création du match et repris tels quels à la clôture.

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
  v_solo   boolean;
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
    v_solo := coalesce((m.group_sizes ->> r.user_id::text)::integer, 1) = 1;

    -- Écart moyen par joueur, du point de vue de l'équipe du joueur.
    v_gap := case when r.user_id = any (m.team_a) then v_total_b - v_total_a else v_total_a - v_total_b end / v_size;
    v_chance := 1 / (1 + power(10::numeric, v_gap / 400));
    v_win := round(40 + 20 * (1 - v_chance))::integer;

    v_result := v_result || jsonb_build_object(
      r.user_id::text,
      jsonb_build_object(
        'win', case when v_placed then v_win * 2 else v_win end,
        'loss', least(r.points, round(public.cod_loss_penalty(r.points) * (0.7 + 0.6 * v_chance) * (case when v_solo then 0.75 else 1 end))::integer),
        'bonus', 0,
        'placement', case when v_placed then v_played + 1 else null end
      )
    );
  end loop;

  return v_result;
end;
$$;
