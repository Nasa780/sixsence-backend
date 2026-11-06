-- Matchs amicaux sans XP, et demandes d'arbitrage ou de correction sur les matchs de Division et de coupe.
--   * team_match_finalize : plus d'XP pour un match amical ;
--   * cod_arbitration_requests : une demande vise un match classé (match_id) ou d'équipe (team_match_id).
-- Idempotent.

create or replace function public.team_match_finalize(p_match uuid, p_scores jsonb, p_winner text, p_resolved_by uuid, p_forfeit boolean default false)
returns public.team_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m      public.team_matches;
  v_gain integer := 0;
  v_loss integer := 0;
  v_ranked boolean;
begin
  if p_winner not in ('A', 'B') then
    raise exception 'INVALID_WINNER';
  end if;
  select * into m from public.team_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status in ('completed', 'cancelled') then
    raise exception 'MATCH_CLOSED';
  end if;
  v_ranked := m.tournament_id is null and not m.friendly;

  if v_ranked then
    v_gain := (m.stakes -> p_winner ->> 'win')::integer;
    v_loss := v_gain;
    update public.teams set points = points + v_gain, wins = wins + 1 where id = case when p_winner = 'A' then m.team_a else m.team_b end;
    update public.teams set points = greatest(0, points - v_loss), losses = losses + 1 where id = case when p_winner = 'A' then m.team_b else m.team_a end;
  end if;

  -- XP : seulement les joueurs du match, et pas en amical.
  if not m.friendly then
    update public.cod_profiles set xp = xp + 500 where user_id = any (case when p_winner = 'A' then m.roster_a else m.roster_b end);
    update public.cod_profiles set xp = xp + 150 where user_id = any (case when p_winner = 'A' then m.roster_b else m.roster_a end);
  end if;

  update public.team_matches
     set status = 'completed', winner = p_winner, scores = p_scores, pending_scores = null, forfeit = p_forfeit,
         points_changes = case when v_ranked
                               then jsonb_build_object(p_winner, v_gain, case when p_winner = 'A' then 'B' else 'A' end, -v_loss)
                               else '{}'::jsonb end,
         resolved_by = p_resolved_by, completed_at = now(), updated_at = now(), activity_at = now()
   where id = p_match
  returning * into m;
  if m.challenge_id is not null then
    update public.team_challenges set status = 'played' where id = m.challenge_id;
  end if;
  return m;
end;
$$;

alter table public.cod_arbitration_requests alter column match_id drop not null;
alter table public.cod_arbitration_requests add column if not exists team_match_id uuid references public.team_matches (id) on delete cascade;
alter table public.cod_arbitration_requests drop constraint if exists cod_arbitration_requests_one_match;
alter table public.cod_arbitration_requests add constraint cod_arbitration_requests_one_match check (num_nonnulls(match_id, team_match_id) = 1);
create index if not exists cod_arbitration_team_match_idx on public.cod_arbitration_requests (team_match_id);
