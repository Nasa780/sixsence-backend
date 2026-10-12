-- Sécurité (conseiller Supabase « function_search_path_mutable ») : les fonctions de
-- calcul et le déclencheur updated_at utilisent un chemin de recherche fixe, comme
-- toutes les autres fonctions du schéma. Aucun changement de comportement.

alter function public.touch_updated_at() set search_path = public;
alter function public.cod_loss_penalty(integer) set search_path = public;
alter function public.cod_win_points(integer) set search_path = public;
alter function public.cod_loss_points(integer, integer) set search_path = public;
