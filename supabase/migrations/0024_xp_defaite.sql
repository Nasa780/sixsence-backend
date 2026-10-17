-- =============================================================================
-- 0024 : XP pour les perdants
-- =============================================================================
--   * victoire +500 XP (inchangé), défaite +150 XP : le niveau avance à chaque match ;
--   * correction d'un match (cod_correct_match, 0023) : l'XP de la défaite est aussi retirée
--     aux anciens perdants avant d'appliquer le bon résultat (matchs terminés après cette migration).
-- Les défaites déjà jouées ne sont pas rattrapées.

create or replace function public.cod_finalize_match(p_match uuid, p_winner text)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  k_win_xp  constant integer := 500;
  k_loss_xp constant integer := 150;
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

  v_preview := public.cod_points_preview(p_match);
  select coalesce(jsonb_object_agg(uid::text, delta), '{}'::jsonb)
    into v_changes
    from (
      select w as uid, coalesce((v_preview -> w::text ->> 'win')::integer, 50) as delta
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
         xp         = p.xp + k_loss_xp,
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

revoke execute on function public.cod_finalize_match(uuid, text) from public, anon, authenticated;
grant execute on function public.cod_finalize_match(uuid, text) to service_role;

-- cod_correct_match (0023) : retire aussi l'XP de la défaite aux anciens perdants.
create or replace function public.cod_correct_match(p_match uuid, p_action text, p_staff uuid, p_reason text, p_max_hours integer)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  k_win_xp  constant integer := 500;
  k_loss_xp constant integer := 150;
  -- Mise en place de l'XP de défaite (application de 0024) : avant, les perdants n'avaient rien reçu.
  k_loss_xp_since constant timestamptz := '2026-10-17 00:45:00+00';
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
         losses = greatest(0, p.losses - 1),
         xp     = greatest(0, p.xp - case when m.completed_at >= k_loss_xp_since then k_loss_xp else 0 end)
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
