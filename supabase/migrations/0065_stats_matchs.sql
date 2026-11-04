-- Statistiques des joueurs lues sur la capture de fin de match (Score, Élim., Poses, Désam.), map par map.
-- Affichage seulement, sans effet sur les points. Table privée : lue et écrite par le backend.
create table if not exists public.match_player_stats (
  match_kind text not null check (match_kind in ('classe', 'division')),
  match_id uuid not null,
  map_no smallint not null default 1 check (map_no between 1 and 5),
  user_id uuid not null references public.users (id) on delete cascade,
  score integer not null check (score between 0 and 50000),
  kills integer not null check (kills between 0 and 300),
  plants integer not null check (plants between 0 and 30),
  defuses integer not null check (defuses between 0 and 30),
  submitted_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (match_kind, match_id, map_no, user_id)
);
create index if not exists match_player_stats_user_idx on public.match_player_stats (user_id, created_at desc);
alter table public.match_player_stats enable row level security;
revoke all on table public.match_player_stats from public, anon, authenticated;
