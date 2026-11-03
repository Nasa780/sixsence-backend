-- Clips des joueurs (YouTube, Twitch, Medal, TikTok) : vitrine du profil, page « Clips », clip de la semaine.
-- Tables privées : lues et écrites par le backend seulement (GET /clips et suivantes).
create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  url text not null,
  provider text not null check (provider in ('youtube', 'twitch', 'medal', 'tiktok')),
  video_id text not null,
  title text not null check (char_length(title) between 1 and 80),
  -- Match rattaché (facultatif) : mode et libellé figés à l'ajout (« Classé · 4v4 · Lotus · victoire »).
  mode text check (mode in ('classe', 'division', 'tournoi')),
  cod_match_id uuid references public.cod_matches (id) on delete set null,
  team_match_id uuid references public.team_matches (id) on delete set null,
  context text,
  created_at timestamptz not null default now(),
  -- Retiré par son auteur ou par l'équipe : caché partout, gardé en base.
  removed_at timestamptz,
  removed_by uuid references public.users (id) on delete set null
);
create index if not exists clips_recent on public.clips (created_at desc) where removed_at is null;
create index if not exists clips_user on public.clips (user_id) where removed_at is null;
create unique index if not exists clips_unique_video on public.clips (user_id, provider, video_id) where removed_at is null;

-- Votes « 🔥 » : un par joueur et par clip.
create table if not exists public.clip_votes (
  clip_id uuid not null references public.clips (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (clip_id, user_id)
);

alter table public.clips enable row level security;
alter table public.clip_votes enable row level security;
revoke all on public.clips, public.clip_votes from anon, authenticated;
