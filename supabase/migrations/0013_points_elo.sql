-- -----------------------------------------------------------------------------
-- SixSence — migration 0013 : points selon le niveau adverse, placement, séries
-- -----------------------------------------------------------------------------
-- Niveau d'une équipe = moyenne des points de ses joueurs. Pour un joueur :
--   f = 0,5 - 1 / (1 + 10^((niveau adverse - niveau de son équipe) / 1000))   (de -0,5 à +0,5)
--   victoire = arrondi(30 + 20 f)                       -> de +20 (bien plus faible) à +40 (bien plus fort)
--   défaite  = arrondi(pénalité du rang × (1 - 0,6 f) × 0,75 si seul)
-- Placement : les 5 premiers matchs terminés de la saison comptent double.
-- Série : 3e victoire d'affilée +3, 4e +6, 5e et suivantes +10 (non doublé).
-- Jamais sous 0 point.
--
-- cod_points_preview sert à la fois à l'affichage avant le match (« Victoire +35 ·
-- Défaite -9 ») et à cod_finalize_match : les points annoncés sont ceux appliqués.
-- Idempotent.

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
    v_f := 0.5 - 1 / (1 + power(10::numeric, ((case when r.in_a then v_avg_b - v_avg_a else v_avg_a - v_avg_b end) / 1000)));

    -- Matchs terminés de la saison déjà joués (hors celui-ci) : placement tant qu'il y en a moins de 5.
    select count(*) into v_played
      from public.cod_matches x
     where x.status = 'completed'
       and x.id <> m.id
       and x.season_id is not distinct from m.season_id
       and (x.team_a @> array[r.user_id] or x.team_b @> array[r.user_id]);
    v_mult := case when v_played < 5 then 2 else 1 end;

    v_size  := coalesce((m.group_sizes ->> r.user_id::text)::integer, 1);
    v_bonus := case when r.win_streak + 1 >= 5 then 10 when r.win_streak + 1 = 4 then 6 when r.win_streak + 1 = 3 then 3 else 0 end;
    v_win   := round(30 + 20 * v_f)::integer * v_mult + v_bonus;
    v_loss  := least(
      r.points,
      round(public.cod_loss_penalty(r.points) * (1 - 0.6 * v_f) * (case when v_size = 1 then 0.75 else 1 end))::integer * v_mult
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

-- Fin de match : variations reprises de cod_points_preview (même calcul que l'affichage).
create or replace function public.cod_finalize_match(p_match uuid, p_winner text)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  k_win_xp  constant integer := 500;
  m         public.cod_matches;
  v_winners uuid[];
  v_losers  uuid[];
  v_preview jsonb;
  v_changes jsonb;
begin
  if p_winner is null or p_winner not in ('A', 'B') then
    raise exception 'INVALID_WINNER';
  end if;

  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status in ('completed', 'cancelled') then
    raise exception 'MATCH_CLOSED';
  end if;

  if p_winner = 'A' then
    v_winners := m.team_a;
    v_losers  := m.team_b;
  else
    v_winners := m.team_b;
    v_losers  := m.team_a;
  end if;

  -- Variations calculées AVANT la mise à jour (elles dépendent des points actuels).
  v_preview := public.cod_points_preview(p_match);
  select coalesce(jsonb_object_agg(uid::text, delta), '{}'::jsonb)
    into v_changes
    from (
      select w as uid, coalesce((v_preview -> w::text ->> 'win')::integer, 30) as delta
        from unnest(v_winners) w
      union all
      select l, -coalesce((v_preview -> l::text ->> 'loss')::integer, 0)
        from unnest(v_losers) l
    ) changes;

  update public.cod_profiles p
     set points      = p.points + (v_changes ->> p.user_id::text)::integer,
         peak_points = greatest(p.peak_points, p.points + (v_changes ->> p.user_id::text)::integer),
         xp          = p.xp + k_win_xp,
         wins        = p.wins + 1,
         win_streak  = p.win_streak + 1,
         best_streak = greatest(p.best_streak, p.win_streak + 1)
   where p.user_id = any (v_winners);

  update public.cod_profiles p
     set points     = greatest(0, p.points + (v_changes ->> p.user_id::text)::integer),
         losses     = p.losses + 1,
         win_streak = 0
   where p.user_id = any (v_losers);

  update public.cod_matches
     set status         = 'completed',
         winner         = p_winner,
         points_changes = v_changes,
         completed_at   = now()
   where id = p_match
  returning * into m;

  return m;
end;
$$;
