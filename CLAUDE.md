# CLAUDE.md

Guide pour Claude Code (et tout contributeur) travaillant sur le **backend de SixSence**, une plateforme de compétition avec matchmaking, mode Ranked et classement.

Le site (Next.js) vit dans un dépôt séparé : `Nasa780/sixsence-frontend`.

## Stack

- Node.js, Express 4 (CommonJS)
- Supabase (PostgreSQL) via `@supabase/supabase-js`
- Authentification Discord OAuth + JWT
- Déployé sur Render (`https://sixsence-backend.onrender.com`) : chaque commit sur `main` est déployé automatiquement (build `npm install`, démarrage `npm start`).

## Commandes

```bash
npm install
npm run dev     # nodemon server.js (port 3001 par défaut, ou $PORT)
npm start       # node server.js
```

Il n'y a pas encore de tests automatisés ni de linter configuré.

## Structure

- `server.js` : point d'entrée (CORS, cookies, désactivation du cache, montage des routes).
- `middleware/auth.js` : vérification du JWT.
- `src/routes/` → `src/controllers/` → `src/models/` : couches HTTP, logique de requête, accès aux données.
- `src/services/` : logique métier (file d'attente, matchmaker, timer global, système de rang, fallback, validation).
- `src/utils/` : client Supabase, logger, gestion du temps, carte aléatoire.

## Routes

Montées dans `server.js` :

- Auth : `GET /auth/discord`, `GET /auth/discord/callback`, `GET /me`
- Classement : `GET /leaderboard/top10`
- File d'attente : `POST /queue/join`, `POST /queue/leave`, `GET /queue/status`, `GET /queue/list`

`adminRoutes.js`, `matchRoutes.js` et `userRoutes.js` existent mais ne sont pas encore montées dans `server.js`.

Les origines CORS autorisées sont codées en dur dans `server.js` (sixsence.fr, www.sixsence.fr, sixsence.vercel.app) : à mettre à jour si un nouveau domaine est ajouté.

## Variables d'environnement

Lues via `dotenv` (fichier `.env` en local, onglet Environment sur Render) :
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `SUPABASE_URL`, `SUPABASE_KEY`, `SESSION_SECRET`, `JWT_SECRET`, `FRONTEND_URL`, `BACKEND_URL`.

Ne jamais committer `.env` ni `node_modules/` (voir `.gitignore`).

## Conventions

- Code et commentaires en français.
