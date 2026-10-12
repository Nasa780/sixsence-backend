-- Barème : une victoire rapporte +30 points quelle que soit la taille du groupe
-- (fin du +26 en groupe de 3 ou plus). La défaite réduite de 25 % pour un joueur
-- seul est conservée (cod_loss_points). Idempotent.

create or replace function public.cod_win_points(p_group_size integer)
returns integer
language sql
immutable
set search_path = public
as $$
  select 30;
$$;
