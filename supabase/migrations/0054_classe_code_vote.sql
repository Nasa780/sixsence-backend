-- 0054 : Classé comme la Division pour le lancement. L'hôte (premier joueur de l'équipe 1) donne le code de la partie
-- privée dans un champ dédié (10 min), 15 min pour lancer la partie ; ensuite seulement, les joueurs peuvent voter
-- l'annulation du match (tous les joueurs de chaque équipe sauf un, points rendus). Plus d'autre annulation par les joueurs.

-- Code de la partie privée : table privée (joueurs du match et arbitres, lue par le backend).
create table if not exists public.cod_match_codes (
  match_id uuid primary key references public.cod_matches (id) on delete cascade,
  code text not null,
  set_by uuid references public.users (id) on delete set null,
  set_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cod_match_codes enable row level security;
create index if not exists cod_match_codes_set_by_idx on public.cod_match_codes (set_by);

-- Heure du code (sans le code) : publique, elle déclenche aussi la mise à jour en direct des feuilles de match.
alter table public.cod_matches add column if not exists game_code_at timestamptz;
-- Joueurs qui votent l'annulation.
alter table public.cod_matches add column if not exists cancel_votes uuid[] not null default '{}';

-- Vote d'annulation (p_vote = false retire le vote) ; match annulé (motif « vote ») dès que tous les joueurs de chaque
-- équipe sauf un ont voté pour (1 sur 2, 2 sur 3, 3 sur 4, 4 sur 5 ; 1 sur 1 en 1v1 de test).
create or replace function public.cod_vote_cancel(p_match uuid, p_user uuid, p_vote boolean, p_after_minutes integer)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
  votes uuid[];
  got_a integer;
  got_b integer;
begin
  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (p_user = any (m.team_a || m.team_b)) then
    raise exception 'NOT_A_PLAYER';
  end if;
  if m.status <> 'in_progress' then
    raise exception 'CANCEL_VOTE_CLOSED';
  end if;
  if m.started_at is null or now() < m.started_at + make_interval(mins => p_after_minutes) then
    raise exception 'CANCEL_VOTE_TOO_EARLY';
  end if;

  votes := array_remove(m.cancel_votes, p_user);
  if p_vote then
    votes := votes || p_user;
  end if;
  select count(*) into got_a from unnest(votes) v where v = any (m.team_a);
  select count(*) into got_b from unnest(votes) v where v = any (m.team_b);

  if got_a >= greatest(1, cardinality(m.team_a) - 1) and got_b >= greatest(1, cardinality(m.team_b) - 1) then
    update public.cod_matches
       set cancel_votes = votes, status = 'cancelled', cancel_reason = 'vote', completed_at = now()
     where id = p_match
    returning * into m;
  else
    update public.cod_matches set cancel_votes = votes where id = p_match returning * into m;
  end if;
  return m;
end;
$$;

revoke all on function public.cod_vote_cancel(uuid, uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.cod_vote_cancel(uuid, uuid, boolean, integer) to service_role;
