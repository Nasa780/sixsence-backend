-- =============================================================================
-- 0022 : demande de correction après validation
-- =============================================================================
--   * motif « misclick » (Erreur de déclaration) accepté pour les demandes d'arbitrage ;
--   * captures (preuves) acceptées pendant 24 h après la validation du match, pour
--     appuyer une demande de correction.

alter table public.cod_arbitration_requests drop constraint if exists cod_arbitration_requests_reason_check;
alter table public.cod_arbitration_requests
  add constraint cod_arbitration_requests_reason_check
  check (reason in ('misclick', 'cheating', 'afk', 'lobby', 'score', 'behavior', 'other'));

create or replace function public.cod_add_proof(p_match uuid, p_user uuid, p_path text)
returns public.cod_match_proofs
language plpgsql
security definer
set search_path = public
as $$
declare
  m     public.cod_matches;
  proof public.cod_match_proofs;
begin
  select * into m from public.cod_matches where id = p_match;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if not (m.team_a @> array[p_user] or m.team_b @> array[p_user]) then
    raise exception 'NOT_A_PLAYER';
  end if;
  -- Match en cours, ou terminé depuis moins de 24 h (demande de correction).
  if not (
    m.status in ('in_progress', 'awaiting_confirmation', 'disputed')
    or (m.status = 'completed' and m.completed_at > now() - interval '24 hours')
  ) then
    raise exception 'MATCH_CLOSED';
  end if;
  if p_path is null or p_path not like (p_match::text || '/' || p_user::text || '/%') or p_path like '%..%' then
    raise exception 'INVALID_PROOF';
  end if;
  if (select count(*) from public.cod_match_proofs where match_id = p_match and user_id = p_user) >= 5 then
    raise exception 'TOO_MANY_PROOFS';
  end if;

  insert into public.cod_match_proofs (match_id, user_id, storage_path)
  values (p_match, p_user, p_path)
  returning * into proof;
  return proof;
end;
$$;

revoke execute on function public.cod_add_proof(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cod_add_proof(uuid, uuid, text) to service_role;

-- Envoi des fichiers dans le bucket : même règle (match en cours ou terminé depuis moins de 24 h).
drop policy if exists "match-proofs: envoi par les joueurs du match" on storage.objects;
create policy "match-proofs: envoi par les joueurs du match"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'match-proofs'
    and (storage.foldername(name))[2] = auth.uid()::text
    and (storage.foldername(name))[1] in (
      select id::text from public.cod_matches
       where (team_a @> array[auth.uid()] or team_b @> array[auth.uid()])
         and (status in ('in_progress', 'awaiting_confirmation', 'disputed')
              or (status = 'completed' and completed_at > now() - interval '24 hours'))
    )
  );
