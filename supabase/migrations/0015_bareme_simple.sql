-- -----------------------------------------------------------------------------
-- SixSence — migration 0015 : barème simple et lisible
-- -----------------------------------------------------------------------------
--   Victoire : +50, pour tout le monde.
--   Défaite  : -20 en Bronze et Argent, -35 en Or, Platine et Diamant,
--              -50 en Maître, Grand Maître, Champion et Légende.
--   Placement : pendant les 10 premiers matchs terminés de la saison, les victoires
--              comptent double (+100) ; les défaites restent normales.
--   Jamais sous 0 point.
-- Fin du réglage selon le niveau adverse, de la protection solo et du bonus de série.
-- cod_points_preview garde la même forme ({ win, loss, bonus: 0, placement }) :
-- cod_finalize_match (0013) l'applique telle quelle. Idempotent.

create or replace function public.cod_loss_penalty(p_points integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select case
    when p_points >= 1500 then 50  -- Maître, Grand Maître, Champion, Légende
    when p_points >= 600  then 35  -- Or, Platine, Diamant
    else 20                        -- Bronze, Argent
  end;
$$;

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
begin
  select * into m from public.cod_matches where id = p_match;
  if not found then
    return null;
  end if;

  for r in
    select p.user_id, p.points
      from public.cod_profiles p
     where p.user_id = any (m.team_a || m.team_b)
  loop
    -- Matchs terminés de la saison déjà joués (hors celui-ci) : placement tant qu'il y en a moins de 10.
    select count(*) into v_played
      from public.cod_matches x
     where x.status = 'completed'
       and x.id <> m.id
       and x.season_id is not distinct from m.season_id
       and (x.team_a @> array[r.user_id] or x.team_b @> array[r.user_id]);
    v_placed := v_played < 10;

    v_result := v_result || jsonb_build_object(
      r.user_id::text,
      jsonb_build_object(
        'win', case when v_placed then 100 else 50 end,
        'loss', least(r.points, public.cod_loss_penalty(r.points)),
        'bonus', 0,
        'placement', case when v_placed then v_played + 1 else null end
      )
    );
  end loop;

  return v_result;
end;
$$;

grant execute on function public.cod_points_preview(uuid) to anon, authenticated, service_role;
