-- Coupe Horus : les joueurs de l'équipe reçoivent aussi le trophée (or / argent / bronze) sur leur profil.
-- cup_medals.kind : 'anubis' (médailles déjà données) ou 'horus'. Joueurs d'une équipe du podium : ceux du check-in
-- (match_roster), sinon l'effectif inscrit (frozen_roster). Rattrapage des Coupes Horus déjà terminées.

alter table public.cup_medals add column if not exists kind text not null default 'anubis';
alter table public.cup_medals drop constraint if exists cup_medals_kind_check;
alter table public.cup_medals add constraint cup_medals_kind_check check (kind in ('anubis', 'horus'));

insert into public.cup_medals (user_id, tournament_id, place, name, team_name, kind, created_at)
select player, t.id, podium.place, t.name, tm.name, 'horus', coalesce(t.completed_at, now())
from public.tournaments t
cross join lateral (values (t.winner_team, 'or'), (t.finalist_team, 'argent'), (t.third_team, 'bronze')) as podium(team_id, place)
join public.tournament_teams tt on tt.tournament_id = t.id and tt.team_id = podium.team_id
join public.teams tm on tm.id = podium.team_id
cross join lateral unnest(coalesce(tt.match_roster, tt.frozen_roster)) as player
where t.kind = 'horus' and t.status = 'completed' and podium.team_id is not null
  and exists (select 1 from public.users u where u.id = player)
on conflict (user_id, tournament_id) do nothing;
