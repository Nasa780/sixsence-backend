-- Message de résultat d'un match d'équipe : le bot y ajoute le meilleur joueur quand la capture arrive.
alter table public.team_matches add column if not exists discord_result_message text;
