-- Tableau de bord de l'activité (onglet Activité de l'admin, GET /admin/activity).
-- Tout est compté ici, en jours et en heures de Paris : la lecture directe des tables serait limitée à 1 000 lignes.
-- p_days : durée de la période ; les jours renvoyés couvrent aussi la période précédente, pour comparer.
create or replace function public.site_activity(p_today date, p_days integer)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select p_today - (p_days * 2 - 1) as first_day, p_today - (p_days - 1) as period_start
  ),
  days as (
    select generate_series(b.first_day, p_today, interval '1 day')::date as day from bounds b
  ),
  matches as (
    select id, 'ranked' as kind, (completed_at at time zone 'Europe/Paris') as local_at, team_a || team_b as players
    from public.cod_matches where status = 'completed'
    union all
    select id, 'division', (completed_at at time zone 'Europe/Paris'), roster_a || roster_b
    from public.team_matches where status = 'completed'
  ),
  appearances as (
    select unnest(players) as user_id, local_at::date as day from matches
  ),
  games as (
    select user_id, count(*) as played from appearances group by user_id
  ),
  active_teams as (
    select t.id, count(m.user_id) as members
    from public.teams t left join public.team_members m on m.team_id = t.id
    where t.disbanded_at is null and t.cup_tournament is null
    group by t.id
  )
  select json_build_object(
    'days', (
      select json_agg(json_build_object(
        'day', d.day,
        'visitors', (select count(*) from public.site_visits v where v.day = d.day),
        'signups', (select count(*) from public.users u where (u.created_at at time zone 'Europe/Paris')::date = d.day),
        'ranked', (select count(*) from matches m where m.kind = 'ranked' and m.local_at::date = d.day),
        'division', (select count(*) from matches m where m.kind = 'division' and m.local_at::date = d.day)
      ) order by d.day)
      from days d
    ),
    'activePlayers', json_build_object(
      'current', (select count(distinct a.user_id) from appearances a, bounds b where a.day >= b.period_start and a.day <= p_today),
      'previous', (select count(distinct a.user_id) from appearances a, bounds b where a.day >= b.first_day and a.day < b.period_start)
    ),
    'hours', (
      select json_agg(json_build_object(
        'hour', h,
        'matches', (select count(*) from matches m, bounds b where extract(hour from m.local_at) = h and m.local_at::date >= b.period_start and m.local_at::date <= p_today)
      ) order by h)
      from generate_series(0, 23) as h
    ),
    'funnel', json_build_object(
      'players', (select count(*) from public.users),
      'activision', (select count(*) from public.cod_profiles where activision_id is not null),
      'played', (select count(*) from games),
      'regular', (select count(*) from games where played >= 5)
    ),
    'community', json_build_object(
      'teams', (select count(*) from active_teams),
      'fullTeams', (select count(*) from active_teams where members >= 4),
      'teamPlayers', (select coalesce(sum(members), 0) from active_teams),
      'twitch', (select count(*) from public.cod_profiles where twitch is not null),
      'clips', (select count(*) from public.clips where removed_at is null)
    )
  );
$$;
revoke all on function public.site_activity(date, integer) from public, anon, authenticated;
