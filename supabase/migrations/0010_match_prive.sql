-- Confidentialité : le chat d'un match, ses captures de preuve et les avertissements
-- des joueurs ne sont plus publics.
--   * chat et preuves : lisibles par les joueurs du match et les admins (le site les
--     reçoit du backend ; cette règle sert aussi aux mises à jour en temps réel) ;
--   * avertissements : privés (lus uniquement par le backend et les fonctions SQL) ;
--   * bucket « match-proofs » privé : le backend fournit des liens temporaires signés.
-- Idempotent.

drop policy if exists "cod_match_messages: lecture publique" on public.cod_match_messages;
drop policy if exists "cod_match_messages: joueurs du match et admins" on public.cod_match_messages;
create policy "cod_match_messages: joueurs du match et admins" on public.cod_match_messages
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.cod_matches m
       where m.id = match_id
         and (m.team_a @> array[(select auth.uid())] or m.team_b @> array[(select auth.uid())])
    )
  );

drop policy if exists "cod_match_proofs: lecture publique" on public.cod_match_proofs;
drop policy if exists "cod_match_proofs: joueurs du match et admins" on public.cod_match_proofs;
create policy "cod_match_proofs: joueurs du match et admins" on public.cod_match_proofs
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.cod_matches m
       where m.id = match_id
         and (m.team_a @> array[(select auth.uid())] or m.team_b @> array[(select auth.uid())])
    )
  );

drop policy if exists "cod_strikes: lecture publique" on public.cod_strikes;

update storage.buckets set public = false where id = 'match-proofs';
