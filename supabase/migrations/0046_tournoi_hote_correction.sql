-- 0046 : matchs de tournoi avec une équipe hôte (code de la partie), résultats reportés dans le tableau,
-- correction d'un match de tournoi par l'équipe SixSence (sans points ni bilan, seulement l'XP).

-- Équipe hôte tirée au sort, comme en Division : sans elle, personne ne pouvait donner le code de la partie.
create or replace function public.tournament_create_match(p_entry bigint, p_maps text[], p_mode text, p_best_of integer)
 returns team_matches
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  e  public.tournament_bracket;
  ra uuid[];
  rb uuid[];
  m  public.team_matches;
begin
  select * into e from public.tournament_bracket where id = p_entry for update;
  if not found or e.status <> 'pending' or e.match_id is not null or e.team_a is null or e.team_b is null then
    return null;
  end if;
  select coalesce(match_roster, frozen_roster) into ra from public.tournament_teams where tournament_id = e.tournament_id and team_id = e.team_a;
  select coalesce(match_roster, frozen_roster) into rb from public.tournament_teams where tournament_id = e.tournament_id and team_id = e.team_b;
  insert into public.team_matches (season_id, team_a, team_b, roster_a, roster_b, points_a, points_b, stakes, mode, maps, tournament_id, round, best_of, host_side, activity_at)
  values (
    (select season_id from public.tournaments where id = e.tournament_id),
    e.team_a, e.team_b, ra, rb,
    (select points from public.teams where id = e.team_a), (select points from public.teams where id = e.team_b),
    '{"A": {"win": 0, "loss": 0}, "B": {"win": 0, "loss": 0}}'::jsonb,
    p_mode,
    (select jsonb_agg(jsonb_build_object('map', map, 'pick', 'random') order by ord) from unnest(p_maps) with ordinality as t(map, ord)),
    e.tournament_id, e.round, p_best_of,
    case when random() < 0.5 then 'A' else 'B' end,
    now()
  )
  returning * into m;
  update public.tournament_bracket set status = 'playing', match_id = m.id where id = p_entry;
  return m;
end;
$function$;

-- Matchs de tournoi encore ouverts sans hôte : tirage maintenant.
update public.team_matches
   set host_side = case when random() < 0.5 then 'A' else 'B' end, activity_at = now()
 where tournament_id is not null and host_side is null and status in ('in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed');

-- Tableaux : résultats des matchs terminés jamais reportés (rencontres restées « en cours »).
update public.tournament_bracket b
   set status = 'done', winner = case when m.winner = 'A' then m.team_a else m.team_b end
  from public.team_matches m
 where m.id = b.match_id and b.status = 'playing' and m.status = 'completed' and m.winner is not null;

-- Correction : aussi pour un match de tournoi (scores ou vainqueur ; pas d'annulation, le tableau en dépend).
-- Un match de tournoi ne change ni les points ni le bilan des équipes : seule l'XP des joueurs est échangée.
create or replace function public.team_match_correct(p_match uuid, p_scores jsonb, p_winner text, p_staff uuid, p_reason text, p_max_hours integer)
 returns team_matches
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  m          public.team_matches;
  v_reason   text := trim(coalesce(p_reason, ''));
  v_old_gain integer;
  v_gain     integer;
  v_winner   uuid;
  v_loser    uuid;
  v_ranked   boolean;
begin
  if char_length(v_reason) not between 3 and 500 then
    raise exception 'INVALID_REASON';
  end if;
  if p_scores is not null and (p_winner is null or p_winner not in ('A', 'B')) then
    raise exception 'INVALID_WINNER';
  end if;

  select * into m from public.team_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status <> 'completed' or m.winner is null then
    raise exception 'MATCH_NOT_COMPLETED';
  end if;
  if m.tournament_id is not null and p_scores is null then
    raise exception 'TOURNAMENT_MATCH';
  end if;
  if p_max_hours is not null and m.completed_at < now() - make_interval(hours => p_max_hours) then
    raise exception 'CORRECTION_TOO_LATE';
  end if;
  v_ranked := m.tournament_id is null and not m.friendly;

  if v_ranked then
    v_old_gain := coalesce((m.points_changes ->> m.winner)::integer, 0);
    v_winner := case when m.winner = 'A' then m.team_a else m.team_b end;
    v_loser  := case when m.winner = 'A' then m.team_b else m.team_a end;
    update public.teams set points = greatest(0, points - v_old_gain), wins = greatest(0, wins - 1) where id = v_winner;
    update public.teams set points = points + v_old_gain, losses = greatest(0, losses - 1) where id = v_loser;
  end if;
  update public.cod_profiles set xp = greatest(0, xp - 500) where user_id = any (case when m.winner = 'A' then m.roster_a else m.roster_b end);
  update public.cod_profiles set xp = greatest(0, xp - 150) where user_id = any (case when m.winner = 'A' then m.roster_b else m.roster_a end);

  insert into public.team_match_corrections (match_id, staff_id, previous_scores, previous_winner, new_scores, new_winner, reason)
  values (p_match, p_staff, m.scores, m.winner, p_scores, p_winner, v_reason);

  if p_scores is null then
    update public.team_matches
       set status = 'cancelled', cancel_reason = 'staff', winner = null, points_changes = '{}'::jsonb, forfeit = false
     where id = p_match;
  else
    if v_ranked then
      v_gain := (m.stakes -> p_winner ->> 'win')::integer;
      v_winner := case when p_winner = 'A' then m.team_a else m.team_b end;
      v_loser  := case when p_winner = 'A' then m.team_b else m.team_a end;
      update public.teams set points = points + v_gain, wins = wins + 1 where id = v_winner;
      update public.teams set points = greatest(0, points - v_gain), losses = losses + 1 where id = v_loser;
    end if;
    update public.cod_profiles set xp = xp + 500 where user_id = any (case when p_winner = 'A' then m.roster_a else m.roster_b end);
    update public.cod_profiles set xp = xp + 150 where user_id = any (case when p_winner = 'A' then m.roster_b else m.roster_a end);
    update public.team_matches
       set scores = p_scores, winner = p_winner, forfeit = false,
           points_changes = case when v_ranked
                                 then jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_gain)
                                 else '{}'::jsonb end
     where id = p_match;
  end if;

  update public.team_matches
     set corrected_at = now(), corrected_by = p_staff, correction_reason = v_reason, discord_done = false, updated_at = now(), activity_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$function$;
