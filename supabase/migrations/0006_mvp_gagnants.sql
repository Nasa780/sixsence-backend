-- =============================================================================
-- SixSence — migration 0006 : règles du vote MVP
--   - on ne vote que pour un joueur de l'équipe gagnante ;
--   - voter pour soi-même est autorisé ;
--   - MVP du mois : à égalité de votes, ceux reçus des autres joueurs (hors vote
--     pour soi) départagent, puis le nombre de matchs, puis l'antériorité.
-- À exécuter après 0005. Idempotent.
-- =============================================================================

create or replace function public.cod_vote_mvp(p_match uuid, p_voter uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
begin
  select * into m from public.cod_matches where id = p_match;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (m.team_a @> array[p_voter] or m.team_b @> array[p_voter]) then
    raise exception 'NOT_A_PLAYER';
  end if;
  if m.status <> 'completed' or m.completed_at < now() - interval '24 hours' then
    raise exception 'MVP_VOTE_CLOSED';
  end if;
  if not ((m.winner = 'A' and m.team_a @> array[p_target]) or (m.winner = 'B' and m.team_b @> array[p_target])) then
    raise exception 'INVALID_MVP';
  end if;

  insert into public.cod_mvp_votes (match_id, voter_id, target_id)
  values (p_match, p_voter, p_target)
  on conflict (match_id, voter_id) do update set target_id = excluded.target_id, created_at = now();
end;
$$;

create or replace function public.cod_award_monthly_mvp(p_month date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start  timestamptz := date_trunc('month', p_month::timestamp) at time zone 'Europe/Paris';
  v_end    timestamptz := (date_trunc('month', p_month::timestamp) + interval '1 month') at time zone 'Europe/Paris';
  v_winner uuid;
  v_votes  integer;
begin
  if v_end > now() then
    return null;
  end if;
  select user_id into v_winner from public.cod_monthly_mvp where month = date_trunc('month', p_month::timestamp)::date;
  if found then
    return v_winner;
  end if;

  select target_id, count(*)
    into v_winner, v_votes
    from public.cod_mvp_votes
   where created_at >= v_start and created_at < v_end
   group by target_id
   order by count(*) desc,
            count(*) filter (where voter_id <> target_id) desc,
            count(distinct match_id) desc,
            max(created_at) asc
   limit 1;
  if v_winner is null then
    return null;
  end if;

  insert into public.cod_monthly_mvp (month, user_id, votes)
  values (date_trunc('month', p_month::timestamp)::date, v_winner, v_votes)
  on conflict (month) do nothing;

  update public.cod_profiles
     set badges = array(select distinct unnest(badges || array['mvp-' || to_char(p_month, 'YYYY-MM')]))
   where user_id = v_winner;
  return v_winner;
end;
$$;

revoke execute on function public.cod_vote_mvp(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.cod_award_monthly_mvp(date)    from public, anon, authenticated;
grant execute on function public.cod_vote_mvp(uuid, uuid, uuid) to service_role;
grant execute on function public.cod_award_monthly_mvp(date)    to service_role;
