-- -----------------------------------------------------------------------------
-- SixSence — migration 0018 : liens site ↔ Discord
-- -----------------------------------------------------------------------------
--   * users.welcomed_at : message de bienvenue Discord envoyé une seule fois
--     (les comptes existants sont considérés comme déjà accueillis) ;
--   * app_state + app_claim : état des tâches périodiques (top de la semaine publié
--     une seule fois, même après un redémarrage) ;
--   * cancel_reason des matchs annulés : 'abandoned' (aucun résultat en 3 h),
--     'staff' (annulé par l'équipe SixSence).
-- Idempotent.

alter table public.users add column if not exists welcomed_at timestamptz;
update public.users set welcomed_at = coalesce(created_at, now()) where welcomed_at is null;

create table if not exists public.app_state (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_state enable row level security; -- privée : backend uniquement

-- Réserve une tâche : vrai si la valeur change (ex. semaine pas encore publiée), faux sinon.
create or replace function public.app_claim(p_key text, p_value text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.app_state (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now()
   where public.app_state.value is distinct from excluded.value;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.app_claim(text, text) from public, anon, authenticated;
grant execute on function public.app_claim(text, text) to service_role;

create or replace function public.cod_resolve_match(p_match uuid, p_winner text)
returns public.cod_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.cod_matches;
begin
  if p_winner is not null then
    return public.cod_finalize_match(p_match, p_winner);
  end if;

  select * into m from public.cod_matches where id = p_match for update;
  if not found then
    raise exception 'MATCH_NOT_FOUND';
  end if;
  if m.status in ('completed', 'cancelled') then
    raise exception 'MATCH_CLOSED';
  end if;

  update public.cod_matches
     set status = 'cancelled', cancel_reason = 'staff', completed_at = now()
   where id = p_match
  returning * into m;
  return m;
end;
$$;

create or replace function public.cod_sweep_matches(p_confirm_minutes integer default 15, p_cancel_minutes integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_count integer := 0;
  v_rows  integer;
begin
  for r in
    select id, reported_winner
      from public.cod_matches
     where status = 'awaiting_confirmation'
       and reported_at < now() - make_interval(mins => p_confirm_minutes)
  loop
    perform public.cod_finalize_match(r.id, r.reported_winner);
    v_count := v_count + 1;
  end loop;

  update public.cod_matches
     set status = 'cancelled', cancel_reason = 'abandoned', completed_at = now()
   where status = 'in_progress'
     and created_at < now() - make_interval(mins => p_cancel_minutes);
  get diagnostics v_rows = row_count;

  return v_count + v_rows;
end;
$$;
