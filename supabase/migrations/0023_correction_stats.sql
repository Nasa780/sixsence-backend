-- =============================================================================
-- 0023 : correction d'un match terminé — toutes les statistiques justes
-- =============================================================================
--   * pic de la saison, série en cours et meilleure série recalculés depuis l'historique
--     des matchs pour chaque joueur du match corrigé ;
--   * inversion du vainqueur : votes MVP du match effacés (ils visaient l'ancienne équipe
--     gagnante ; le vote se rouvre 24 h pour la nouvelle) ;
--   * message de résultat Discord retenu (discord_result_message) pour être remplacé.

alter table public.cod_matches add column if not exists discord_result_message text;

-- Recalcule pic de la saison, série en cours et meilleure série d'un joueur depuis ses matchs
-- terminés : pic = plus haut total atteint en rejouant les variations de la saison en cours ;
-- séries comptées saison par saison (la série repart à zéro à chaque clôture).
create or replace function public.cod_recompute_player_stats(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season  integer := (select id from public.seasons where is_active limit 1);
  r         record;
  v_total   integer := 0;
  v_peak    integer := 0;
  v_current integer := 0;
  v_best    integer := 0;
  v_run     integer := 0;
  v_prev    integer := null;
begin
  for r in
    select m.season_id,
           coalesce((m.points_changes ->> p_user::text)::integer, 0) as delta,
           (m.winner = 'A' and p_user = any (m.team_a)) or (m.winner = 'B' and p_user = any (m.team_b)) as won
      from public.cod_matches m
     where m.status = 'completed'
       and (p_user = any (m.team_a) or p_user = any (m.team_b))
     order by m.season_id nulls first, m.completed_at, m.created_at
  loop
    if v_prev is distinct from r.season_id then
      v_run := 0;
      v_prev := r.season_id;
    end if;
    v_run := case when r.won then v_run + 1 else 0 end;
    v_best := greatest(v_best, v_run);
    if r.season_id = v_season then
      v_total := greatest(0, v_total + r.delta);
      v_peak := greatest(v_peak, v_total);
      v_current := v_run;
    end if;
  end loop;

  update public.cod_profiles
     set peak_points = greatest(v_peak, points),
         win_streak  = v_current,
         best_streak = v_best
   where user_id = p_user;
end;
$$;

revoke execute on function public.cod_recompute_player_stats(uuid) from public, anon, authenticated;
grant execute on function public.cod_recompute_player_stats(uuid) to service_role;

-- cod_correct_match (0021) complétée : votes MVP effacés lors d'une inversion, statistiques
-- recalculées pour tous les joueurs du match.
create or replace function public.cod_correct_match(p_match uuid, p_action text, p_staff uuid, p_reason text, p_max_hours integer)
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
  v_changes jsonb;
  v_new     text;
  v_reason  text := trim(coalesce(p_reason, ''));
  v_id      bigint;
  v_player  uuid;
begin
  if p_action is null or p_action not in ('swap', 'cancel') then
    raise exception 'INVALID_ACTION';
  end if;
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'INVALID_REASON';
  end if;

  perform pg_advisory_xact_lock(hashtext('sixsence_cod_matchmaking'));

  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status <> 'completed' or m.winner is null then
    raise exception 'MATCH_NOT_COMPLETED';
  end if;
  if p_max_hours is not null and m.completed_at < now() - make_interval(hours => p_max_hours) then
    raise exception 'CORRECTION_TOO_LATE';
  end if;

  if m.winner = 'A' then
    v_winners := m.team_a;
    v_losers  := m.team_b;
    v_new     := 'B';
  else
    v_winners := m.team_b;
    v_losers  := m.team_a;
    v_new     := 'A';
  end if;
  v_changes := coalesce(m.points_changes, '{}'::jsonb);

  update public.cod_profiles p
     set points = greatest(0, p.points - coalesce((v_changes ->> p.user_id::text)::integer, 0)),
         wins   = greatest(0, p.wins - 1),
         xp     = greatest(0, p.xp - k_win_xp)
   where p.user_id = any (v_winners);

  update public.cod_profiles p
     set points = greatest(0, p.points - coalesce((v_changes ->> p.user_id::text)::integer, 0)),
         losses = greatest(0, p.losses - 1)
   where p.user_id = any (v_losers);

  insert into public.cod_match_corrections (match_id, staff_id, action, previous_winner, new_winner, reason, points_before)
  values (p_match, p_staff, p_action, m.winner, case when p_action = 'swap' then v_new end, v_reason, v_changes)
  returning id into v_id;

  -- Les votes MVP visaient l'ancienne équipe gagnante.
  delete from public.cod_mvp_votes where match_id = p_match;

  if p_action = 'cancel' then
    update public.cod_matches
       set status = 'cancelled', cancel_reason = 'staff', winner = null, points_changes = '{}'::jsonb
     where id = p_match;
  else
    update public.cod_matches set status = 'disputed', winner = null, points_changes = '{}'::jsonb where id = p_match;
    perform public.cod_finalize_match(p_match, v_new);
  end if;

  update public.cod_matches
     set corrected_at = now(), corrected_by = p_staff, correction_reason = v_reason, correction_action = p_action,
         discord_done = false
   where id = p_match
  returning * into m;

  -- Pic de la saison et séries recalculés depuis l'historique (le match corrigé compris).
  foreach v_player in array (m.team_a || m.team_b) loop
    perform public.cod_recompute_player_stats(v_player);
  end loop;

  update public.cod_match_corrections set points_after = m.points_changes where id = v_id;
  return m;
end;
$$;

revoke execute on function public.cod_correct_match(uuid, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.cod_correct_match(uuid, text, uuid, text, integer) to service_role;
