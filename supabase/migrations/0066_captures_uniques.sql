-- Captures de fin de match déjà utilisées : une même image ne sert qu'une fois, tous matchs confondus.
-- Table privée : lue et écrite par le backend seulement.
create table if not exists public.match_captures (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  match_kind text not null check (match_kind in ('classe', 'division')),
  match_id uuid not null,
  map_no smallint not null,
  submitted_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists match_captures_match_idx on public.match_captures (match_kind, match_id);
alter table public.match_captures enable row level security;
revoke all on table public.match_captures from public, anon, authenticated;
