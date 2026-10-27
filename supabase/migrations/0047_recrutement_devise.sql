-- 0047 : recrutement ouvert ou fermé d'une équipe (avec un message), devise de chaque joueur dans l'effectif.

alter table public.teams add column if not exists recruiting boolean not null default true;
alter table public.teams add column if not exists recruiting_note text;
alter table public.teams drop constraint if exists teams_recruiting_note_len;
alter table public.teams add constraint teams_recruiting_note_len check (recruiting_note is null or char_length(recruiting_note) <= 120);

-- Devise d'un joueur dans son équipe, choisie par les Leaders (40 caractères).
alter table public.team_members add column if not exists motto text;
alter table public.team_members drop constraint if exists team_members_motto_len;
alter table public.team_members add constraint team_members_motto_len check (motto is null or char_length(motto) <= 40);
