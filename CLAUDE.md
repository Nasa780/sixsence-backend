# CLAUDE.md

Guide pour Claude Code (et tout contributeur) travaillant sur le **backend de SixSence**, une plateforme de compétition : classé Call of Duty 5v5 (file d'attente, matchmaking, points, classement) et événements GTA 6.

Le site (Next.js) vit dans un dépôt séparé : `Nasa780/sixsence-frontend`.

## Stack

- Node.js, Express 4, WebSocket (`ws`), TypeScript (ESM)
- Supabase (PostgreSQL + Auth Discord) via `@supabase/supabase-js`, avec la clé **secrète**
- Déployé sur Render (`https://sixsence-backend.onrender.com`) : chaque commit sur `main` est déployé automatiquement. Render lance `npm install` (le `postinstall` compile TypeScript vers `dist/`) puis `npm start`.

## Commandes

```bash
npm install          # installe et compile (postinstall)
npm run dev          # tsx watch, lit .env (port 4000 par défaut)
npm run typecheck
npm start            # node dist/index.js
```

Pas encore de tests automatisés. Pour tester un match seul, `COD_TEAM_SIZE=1` dans `.env` (un match à deux comptes).

## Structure

- `src/index.ts` : point d'entrée (CORS, routes, WebSocket, ménage périodique des matchs).
- `src/config.ts` : variables d'environnement, origines CORS autorisées (liste par défaut incluse).
- `src/auth.ts` : vérification du jeton de session Supabase (exige le fournisseur Discord).
- `src/routes/` : `cod.ts` (file, matchs, chat, preuves), `gta.ts` (événements), `admin.ts` (administration, rôle admin).
- `src/services/` : logique métier, qui appelle surtout les fonctions SQL ; `discord.ts` : intégration Discord (DM, salons vocaux, résultats), désactivée sans `DISCORD_BOT_TOKEN`.
- `src/ws/hub.ts` : WebSocket de la file (protocole décrit en tête du fichier).
- `supabase/migrations/` : `0001_init.sql` (tables, RLS, fonctions atomiques) puis `0002_ready_sanctions_saisons.sql` et `0003_activision_unique.sql`. À exécuter dans l'ordre dans le SQL Editor de Supabase ; idempotents.

## Règles métier

- **Lecture publique** : tout le site est visible sans connexion (RLS `select` ouvert à `anon`).
- **Écritures** : uniquement via le backend et les fonctions SQL (`cod_join_queue`, `cod_try_create_match`, `cod_finalize_match`, …). Seule exception : un joueur peut modifier son `activision_id` et sa `platform`.
- **Barème** (aligné sur la page Ranked du site) : victoire +30 points et +500 XP ; défaite -10 (Bronze) à -30 (Champion) selon le rang, jamais sous 0. Voir `cod_loss_penalty` et `cod_finalize_match`.
- **Vérification « Prêt ? »** : un match trouvé démarre en `ready_check` ; chaque joueur a 60 s (`COD_READY_SECONDS`) pour accepter. Délai dépassé : match annulé, joueurs prêts remis en tête de file, absents sanctionnés.
- **Sanctions** (`cod_apply_strike`) : sur 24 h glissantes, 1er avertissement sans effet, 2e = 15 min sans file, 3e = 1 h, ensuite 24 h.
- **Preuves** : captures dans le bucket Storage `match-proofs` (`<match>/<joueur>/fichier`), enregistrées par `cod_add_proof`.
- **Saisons** : `cod_close_season` archive le classement (`season_results`), donne les badges `s<id>-top10` / `s<id>-champion`, remet points et victoires à zéro (XP conservée).
- **Identifiant Activision unique** : un même identifiant (sans tenir compte des majuscules ni des espaces) ne peut servir qu'à un seul compte (index `cod_profiles_activision_unique`, erreur 23505).
- Un résultat déclaré est validé d'office après 15 min sans réponse ; un match jamais déclaré est annulé après 3 h.

## Routes

Publiques : `GET /health`, `GET /stats`, `GET /cod/status`, `GET /cod/matches/:id`, `GET /gta/events`, `GET /gta/events/:id`.

Connexion Discord requise (`Authorization: Bearer <jeton Supabase>`) : `GET /cod/queue`, `POST /cod/queue/join|leave`, `POST /cod/matches/:id/ready|report|confirm|messages|proofs`, `POST|DELETE /gta/events/:id/register`.

Admin (`users.role = 'admin'`) : `POST /cod/matches/:id/resolve`, `POST /gta/events`, et tout `/admin/*` (voir l'en-tête de `src/routes/admin.ts`).

Erreurs : `{ "error": { "code": "EVENT_FULL", "message": "..." } }`.

## Variables d'environnement

Voir `.env.example`. Indispensables : `SUPABASE_URL` et la clé secrète `SUPABASE_SERVICE_ROLE_KEY` (l'ancien nom `SUPABASE_KEY` est accepté). Optionnelles : `CORS_ORIGINS`, `COD_TEAM_SIZE`, `COD_MAPS`, `COD_MODES`, `COD_CONFIRM_MINUTES`, `COD_CANCEL_MINUTES`, `COD_READY_SECONDS`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_MATCH_CATEGORY_ID`, `DISCORD_RESULTS_CHANNEL_ID`, `SITE_URL`.

Une vérification automatique (`.github/workflows/ci.yml`) compile le projet à chaque PR.

Ne jamais committer `.env`, `node_modules/` ni `dist/` (voir `.gitignore`).

## Conventions

- Code et commentaires en français.
- Une seule instance Render : les connexions WebSocket et le limiteur de débit vivent en mémoire.
