-- 0076 : un joueur remis à 0 match quitte le classement (cod_leaderboard).
--
-- cod_leaderboard est une table recopiée depuis cod_profiles par le déclencheur cod_profiles_sync_leaderboard
-- (0001_init.sql). Elle ajoutait ou mettait à jour un joueur qui a joué, mais ne retirait jamais celui qui retombe
-- à 0 match : après la remise à zéro des tests 1v1 (2026-11-06), baj7min14. restait affiché à 100 points alors que
-- son profil était à 0. Désormais, un profil sans victoire ni défaite (remise à zéro, archivage, nouvelle saison)
-- retire sa ligne du classement. Idempotente.

create or replace function public.sync_cod_leaderboard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if (new.wins + new.losses) > 0 then
    insert into public.cod_leaderboard (user_id, username, avatar_url, points, wins, losses, win_streak, updated_at)
    select new.user_id, u.username, u.avatar_url, new.points, new.wins, new.losses, new.win_streak, now()
    from public.users u
    where u.id = new.user_id
    on conflict (user_id) do update
      set username   = excluded.username,
          avatar_url = excluded.avatar_url,
          points     = excluded.points,
          wins       = excluded.wins,
          losses     = excluded.losses,
          win_streak = excluded.win_streak,
          updated_at = now();
  else
    -- Plus aucun match (remise à zéro) : le joueur quitte le classement.
    delete from public.cod_leaderboard where user_id = new.user_id;
  end if;
  return new;
end;
$function$;

-- Rattrapage : lignes déjà restées au classement pour des profils à 0 match.
delete from public.cod_leaderboard l
using public.cod_profiles p
where p.user_id = l.user_id and (p.wins + p.losses) = 0;
