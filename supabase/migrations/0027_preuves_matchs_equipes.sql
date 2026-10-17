-- =============================================================================
-- 0027 : captures de preuve des matchs d'équipe
-- =============================================================================
--   * bucket privé « team-match-proofs » : un titulaire envoie ses captures dans
--     <match_id>/<user_id>/<fichier>, pendant le match ou jusqu'à 24 h après sa fin ;
--   * team_match_proofs : captures enregistrées (5 au plus par joueur et par match), lues par le
--     backend qui fournit des liens signés aux joueurs du match et aux arbitres.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-match-proofs', 'team-match-proofs', false, 5242880, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "team-match-proofs: envoi par les titulaires" on storage.objects;
create policy "team-match-proofs: envoi par les titulaires"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'team-match-proofs'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[1] in (
      select id::text from public.team_matches
       where (roster_a @> array[auth.uid()] or roster_b @> array[auth.uid()])
         and (status in ('in_progress', 'awaiting_confirmation', 'disputed')
              or (status = 'completed' and completed_at > now() - interval '24 hours'))
    )
  );

create table if not exists public.team_match_proofs (
  id           bigint generated always as identity primary key,
  match_id     uuid not null references public.team_matches (id) on delete cascade,
  user_id      uuid not null references public.users (id) on delete cascade,
  storage_path text not null unique,
  created_at   timestamptz not null default now()
);
create index if not exists team_match_proofs_match on public.team_match_proofs (match_id);
alter table public.team_match_proofs enable row level security;
-- Aucune politique : lue et écrite par le backend seulement (liens signés).
