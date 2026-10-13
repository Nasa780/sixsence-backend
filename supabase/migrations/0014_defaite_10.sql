-- -----------------------------------------------------------------------------
-- SixSence — migration 0014 : défaite ajustée de ±10 % selon le niveau adverse
-- -----------------------------------------------------------------------------
-- Comme la victoire (+45 à +55 autour de +50), la défaite varie désormais de ±10 %
-- autour de la pénalité du rang : défaite = arrondi(pénalité × (1 - 0,2 f) × 0,75 si seul).
-- Exemple Maître (pénalité 50), en groupe : -45 contre bien plus fort, -50 à niveau
-- égal, -55 contre bien plus faible. Le reste de 0013 est inchangé. Idempotent.

create or replace function public.cod_points_preview(p_match uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m        public.cod_matches;
  v_avg_a  numeric;
  v_avg_b  numeric;
  v_result jsonb := '{}'::jsonb;
  r        record;
  v_f      numeric;
  v_mult   integer;
  v_win    integer;
  v_loss   integer;
  v_bonus  integer;
  v_size   integer;
  v_played integer;
begin
  select * into m from public.cod_matches where id = p_match;
  if not found then
    return null;
  end if;

  select coalesce(avg(points), 0) into v_avg_a from public.cod_profiles where user_id = any (m.team_a);
  select coalesce(avg(points), 0) into v_avg_b from public.cod_profiles where user_id = any (m.team_b);

  for r in
    select p.user_id, p.points, p.win_streak, (p.user_id = any (m.team_a)) as in_a
      from public.cod_profiles p
     where p.user_id = any (m.team_a || m.team_b)
  loop
    v_f := 0.5 - 1 / (1 + power(10::numeric, ((case when r.in_a then v_avg_b - v_avg_a else v_avg_a - v_avg_b end) / 600)));

    -- Matchs terminés de la saison déjà joués (hors celui-ci) : placement tant qu'il y en a moins de 10.
    select count(*) into v_played
      from public.cod_matches x
     where x.status = 'completed'
       and x.id <> m.id
       and x.season_id is not distinct from m.season_id
       and (x.team_a @> array[r.user_id] or x.team_b @> array[r.user_id]);
    v_mult := case when v_played < 10 then 2 else 1 end;

    v_size  := coalesce((m.group_sizes ->> r.user_id::text)::integer, 1);
    v_bonus := case when r.win_streak + 1 >= 5 then 15 when r.win_streak + 1 = 4 then 10 when r.win_streak + 1 = 3 then 5 else 0 end;
    v_win   := round(50 + 10 * v_f)::integer * v_mult + v_bonus;
    v_loss  := least(
      r.points,
      round(public.cod_loss_penalty(r.points) * (1 - 0.2 * v_f) * (case when v_size = 1 then 0.75 else 1 end))::integer * v_mult
    );

    v_result := v_result || jsonb_build_object(
      r.user_id::text,
      jsonb_build_object(
        'win', v_win,
        'loss', v_loss,
        'bonus', v_bonus,
        'placement', case when v_mult = 2 then v_played + 1 else null end
      )
    );
  end loop;

  return v_result;
end;
$$;

grant execute on function public.cod_points_preview(uuid) to anon, authenticated, service_role;
