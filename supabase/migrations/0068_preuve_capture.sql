-- Image gardée comme preuve pour chaque capture de stats : les arbitres la voient à côté des chiffres de la map.
alter table public.match_captures add column if not exists proof_path text;
