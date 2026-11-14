-- =============================================================================
-- 0074 : messagerie entre joueurs (messages privés, étape 1)
-- =============================================================================
-- Conversations à deux (une par paire de joueurs, user_a < user_b) et leurs messages (1 000 caractères au plus).
-- Écritures par le backend seulement. Lecture : chaque joueur ne voit que ses propres conversations et messages
-- (RLS), ce qui permet au site de recevoir les nouveaux messages en temps réel (publication supabase_realtime).
-- Personne d'autre ne les lit (l'équipe seulement sur signalement, étape 2, par le backend).
-- Messages supprimés 30 jours après l'envoi (ménage du backend). Idempotent.

create table if not exists public.dm_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.users (id) on delete cascade,
  user_b uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  last_sender uuid references public.users (id) on delete set null,
  last_body text,
  constraint dm_conversations_pair check (user_a < user_b),
  constraint dm_conversations_unique unique (user_a, user_b)
);

create index if not exists dm_conversations_a on public.dm_conversations (user_a, last_message_at desc);
create index if not exists dm_conversations_b on public.dm_conversations (user_b, last_message_at desc);

create table if not exists public.dm_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.dm_conversations (id) on delete cascade,
  sender_id uuid not null references public.users (id) on delete cascade,
  recipient_id uuid not null references public.users (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists dm_messages_conversation on public.dm_messages (conversation_id, created_at desc);
create index if not exists dm_messages_unread on public.dm_messages (recipient_id, conversation_id) where read_at is null;
create index if not exists dm_messages_sender on public.dm_messages (sender_id, created_at desc);
create index if not exists dm_messages_created on public.dm_messages (created_at);

alter table public.dm_conversations enable row level security;
alter table public.dm_messages enable row level security;
revoke all on public.dm_conversations from anon, authenticated;
revoke all on public.dm_messages from anon, authenticated;
grant select on public.dm_conversations to authenticated;
grant select on public.dm_messages to authenticated;

drop policy if exists dm_conversations_participants on public.dm_conversations;
create policy dm_conversations_participants on public.dm_conversations
  for select to authenticated
  using ((select auth.uid()) in (user_a, user_b));

drop policy if exists dm_messages_participants on public.dm_messages;
create policy dm_messages_participants on public.dm_messages
  for select to authenticated
  using ((select auth.uid()) in (sender_id, recipient_id));

-- Temps réel : nouveaux messages et lectures reçus par le site (filtrés par la RLS ci-dessus).
do $$
declare
  t text;
begin
  foreach t in array array['dm_messages', 'dm_conversations'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
