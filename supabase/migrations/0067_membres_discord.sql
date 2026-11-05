-- Membres du serveur Discord : qui a déjà été annoncé, pour les messages d'arrivée et de départ du bot.
-- Sert à ne jamais annoncer deux fois et à rattraper ce qui a été manqué pendant une coupure.
create table if not exists public.discord_members (
  user_id text primary key,
  username text,
  present boolean not null default true,
  joined_at timestamptz,
  left_at timestamptz
);

alter table public.discord_members enable row level security; -- privée : backend uniquement
