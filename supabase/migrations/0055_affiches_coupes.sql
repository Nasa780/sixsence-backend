-- 0055 : affiche de chaque coupe (Horus, Anubis) et de chaque rendez-vous récurrent, comme sur Sked. Sans affiche
-- envoyée, le site en génère une (/api/og/affiche) avec le nom, la date et le format de la coupe.

alter table public.tournaments add column if not exists poster_url text;
alter table public.cup_schedules add column if not exists poster_url text;

-- Affiches envoyées par l'admin depuis le site (compressées en WebP), lecture publique.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cup-posters', 'cup-posters', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "cup-posters: envoi par un admin" on storage.objects;
create policy "cup-posters: envoi par un admin" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cup-posters' and public.is_admin());
