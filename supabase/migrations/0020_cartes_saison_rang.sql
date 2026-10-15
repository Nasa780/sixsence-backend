-- =============================================================================
-- 0020 : cartes de rang de saison
-- =============================================================================
-- Chaque saison donne une carte du plus haut rang atteint pendant la saison
-- (« s<id>-rang-<rang> », calculée par le backend). Le pic de points de la saison
-- est donc archivé avec le classement final à la clôture.

alter table public.season_results add column if not exists peak_points integer;

-- Clôture la saison active : archive le classement (avec le pic de points de la saison),
-- attribue les badges (s<id>-champion au 1er, s<id>-top10 aux dix premiers), remet points,
-- pic, victoires, défaites et séries à zéro, puis ouvre la saison suivante.
-- L'XP et le record de série sont conservés. Renvoie le nombre de joueurs archivés.
create or replace function public.cod_close_season(p_next_name text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season  public.seasons;
  v_count   integer;
begin
  if p_next_name is null or char_length(trim(p_next_name)) not between 2 and 40 then
    raise exception 'INVALID_SEASON_NAME';
  end if;

  perform pg_advisory_xact_lock(hashtext('sixsence_cod_matchmaking'));

  select * into v_season from public.seasons where is_active for update;
  if not found then
    raise exception 'NO_ACTIVE_SEASON';
  end if;

  if exists (select 1 from public.cod_matches where status in ('ready_check', 'in_progress', 'awaiting_confirmation', 'disputed')) then
    raise exception 'MATCHES_IN_PROGRESS';
  end if;

  insert into public.season_results (season_id, user_id, position, username, points, wins, losses, peak_points)
  select v_season.id, l.user_id, row_number() over (order by l.points desc, l.wins desc), l.username, l.points, l.wins, l.losses,
         greatest(coalesce(p.peak_points, 0), l.points)
    from public.cod_leaderboard l
    left join public.cod_profiles p on p.user_id = l.user_id;
  get diagnostics v_count = row_count;

  update public.cod_profiles p
     set badges = array(select distinct unnest(p.badges || array['s' || v_season.id || '-top10']))
    from public.season_results r
   where r.season_id = v_season.id and r.user_id = p.user_id and r.position <= 10;

  update public.cod_profiles p
     set badges = array(select distinct unnest(p.badges || array['s' || v_season.id || '-champion']))
    from public.season_results r
   where r.season_id = v_season.id and r.user_id = p.user_id and r.position = 1;

  delete from public.cod_queue;
  delete from public.cod_leaderboard;
  update public.cod_profiles
     set points = 0, peak_points = 0, wins = 0, losses = 0, win_streak = 0
   where wins + losses > 0 or points > 0;

  update public.seasons set is_active = false, ends_at = now() where id = v_season.id;
  insert into public.seasons (name, is_active) values (trim(p_next_name), true);

  return v_count;
end;
$$;

revoke execute on function public.cod_close_season(text) from public, anon, authenticated;
grant execute on function public.cod_close_season(text) to service_role;
