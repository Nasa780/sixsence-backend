-- =============================================================================
-- 0075 : messagerie, étape 2 (protection des joueurs)
-- =============================================================================
-- - dm_prefs : qui peut écrire au joueur (all = tout le monde, team = son équipe, none = personne). Privée.
-- - dm_blocks : joueurs bloqués ; dans un sens comme dans l'autre, plus aucun message entre eux. Privée.
-- - dm_conversations.created_by : qui a lancé la conversation (10 nouvelles conversations par jour au plus).
-- - cod_player_reports : signalement d'une conversation (motif « spam » ajouté), avec une copie des derniers
--   messages (dm_snapshot) : c'est la seule chose que l'équipe voit d'une conversation ; copie effacée
--   30 jours après le traitement du signalement (ménage du backend). Idempotent.

create table if not exists public.dm_prefs (
  user_id uuid primary key references public.users (id) on delete cascade,
  allow text not null default 'all' check (allow in ('all', 'team', 'none')),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_blocks (
  blocker_id uuid not null references public.users (id) on delete cascade,
  blocked_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists dm_blocks_blocked on public.dm_blocks (blocked_id);

alter table public.dm_prefs enable row level security;
alter table public.dm_blocks enable row level security;
revoke all on public.dm_prefs from anon, authenticated;
revoke all on public.dm_blocks from anon, authenticated;

alter table public.dm_conversations add column if not exists created_by uuid references public.users (id) on delete set null;
create index if not exists dm_conversations_created_by on public.dm_conversations (created_by, created_at);

alter table public.cod_player_reports add column if not exists conversation_id uuid references public.dm_conversations (id) on delete set null;
alter table public.cod_player_reports add column if not exists dm_snapshot jsonb;
alter table public.cod_player_reports drop constraint if exists cod_player_reports_reason_check;
alter table public.cod_player_reports add constraint cod_player_reports_reason_check
  check (reason in ('cheating', 'toxicity', 'afk', 'smurf', 'name', 'spam', 'other'));
