# CLAUDE.md

Guide pour Claude Code (et tout contributeur) travaillant sur le **backend de SixSence**, une plateforme de compétition : classé Call of Duty en files 2v2, 3v3, 4v4 et 5v5, seul ou en groupe (file d'attente, matchmaking, points, classement) et événements GTA 6.

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

`npm test` lance les tests du matchmaking (`src/services/matchmaker.test.ts`, aussi exécutés par la CI). Pour tester un match à deux comptes, `COD_TEAM_SIZE=1` ajoute une file « 1v1 (test) ».

## Structure

- `src/index.ts` : point d'entrée (CORS, routes, WebSocket, ménage périodique des matchs).
- `src/config.ts` : variables d'environnement, origines CORS autorisées (liste par défaut incluse).
- `src/auth.ts` : vérification du jeton de session Supabase (exige le fournisseur Discord).
- `src/routes/` : `cod.ts` (file, matchs, chat, preuves), `gta.ts` (événements), `admin.ts` (administration, rôle admin).
- `src/services/` : logique métier, qui appelle surtout les fonctions SQL ; `discord.ts` : intégration Discord (DM, salons vocaux, résultats), désactivée sans `DISCORD_BOT_TOKEN` ; `community.ts` : rôles automatiques (rangs, COD, GTA), annonces et rappels GTA ; `announcePolicy.ts` : règles anti-spam des annonces (testées) ; `alerts.ts` + `alertPolicy.ts` : alertes d'erreurs dans Discord (testées).
- `src/ws/hub.ts` : WebSocket de la file (protocole décrit en tête du fichier).
- `supabase/migrations/` : `0001_init.sql` (tables, RLS, fonctions atomiques) puis `0002_ready_sanctions_saisons.sql`, `0003_activision_unique.sql` `0004_formats_groupes.sql` (files par format, groupes, barème selon la taille du groupe) `0005_mvp_moderation.sql` (vote du MVP, arbitrages, signalements) et `0006_mvp_gagnants.sql` (MVP choisi dans l'équipe gagnante) `0007_rappels_gta.sql` (rappels des événements GTA) `0008_notifications_push.sql` (abonnements push, clés VAPID), `0009_search_path.sql` et `0010_match_prive.sql` (chat, preuves et avertissements privés), `0011_file_duree_max.sql` (durée maximale de recherche), `0012_victoire_30.sql` (victoire +30 pour tous), `0013_points_elo.sql` (rangs tous les 300 points, points selon le niveau adverse, placement, séries). À exécuter dans l'ordre dans le SQL Editor de Supabase ; idempotents.

## Règles métier

- **Lecture publique** : tout le site est visible sans connexion (RLS `select` ouvert à `anon`), sauf le chat et les preuves d'un match (joueurs du match et admins : `getMatch` renvoie `privateAccess`, bucket `match-proofs` privé avec liens signés d'1 h) et les avertissements (privés).
- **Écritures** : uniquement via le backend et les fonctions SQL (`cod_join_queue`, `cod_try_create_match`, `cod_finalize_match`, …). Seule exception : un joueur peut modifier son `activision_id` et sa `platform`.
- **Barème** (`cod_points_preview`, repris par `cod_finalize_match` : les points affichés avant le match sont ceux appliqués) : niveau d'équipe = moyenne des points ; rangs tous les 300 points (Bronze 0 … Champion 2100, voir aussi `RANK_ROLES` dans community.ts) ; f = 0,5 - 1/(1+10^((adverse - sien)/600)) ; victoire = 50 + 30f (de +35 à +65) ; défaite = pénalité du rang (`cod_loss_penalty` : Bronze 15, Argent 20, Or 25, Platine 30, Diamant 35, Maître et au-delà 50) × (1 - 0,6f), × 0,75 en solo ; placement : 10 premiers matchs de la saison ×2 ; série : 3e victoire +5, 4e +10, 5e et plus +15 ; +500 XP par victoire ; jamais sous 0.
- **Vérification « Prêt ? »** : un match trouvé démarre en `ready_check` ; chaque joueur a 60 s (`COD_READY_SECONDS`) pour accepter. Délai dépassé : match annulé, joueurs prêts remis en tête de file, absents sanctionnés.
- **Sanctions** (`cod_apply_strike`) : sur 24 h glissantes, 1er avertissement sans effet, 2e = 15 min sans file, 3e = 1 h, ensuite 24 h.
- **Preuves** : captures dans le bucket Storage `match-proofs` (`<match>/<joueur>/fichier`), enregistrées par `cod_add_proof`.
- **Saisons** : `cod_close_season` archive le classement (`season_results`), donne les badges `s<id>-top10` / `s<id>-champion`, remet points et victoires à zéro (XP conservée).
- **Identifiant Activision unique** : un même identifiant (sans tenir compte des majuscules ni des espaces) ne peut servir qu'à un seul compte (index `cod_profiles_activision_unique`, erreur 23505).
- **Files et groupes** : une file par format (`COD_FORMATS`, « 2v2,3v3,4v4,5v5 » par défaut). On joue seul ou en groupe (`cod_parties`, code d'invitation) ; le chef lance la file pour tout le groupe, qui n'est jamais séparé. Le serveur propose les équipes (`services/matchmaker.ts`, le groupe le plus ancien est servi en premier) et `cod_create_group_match` revérifie tout sous verrou.
- **MVP** : chaque joueur d'un match terminé vote pour un joueur de l'équipe gagnante, lui-même compris (24 h). À égalité, les votes reçus des autres joueurs départagent ; sinon co-MVP. Le plus élu du mois écoulé reçoit le badge `mvp-AAAA-MM` (`cod_award_monthly_mvp`, vérifié toutes les heures).
- **Arbitrages et signalements** : privés (pas de lecture publique), traités dans `/admin`, annoncés dans `DISCORD_STAFF_CHANNEL_ID` s'il est défini.
- **Discord** : rôles de rang (Bronze … Champion) et « Player COD » mis à jour après chaque match, « Player GTA » à la première inscription à un événement (rôles créés par le bot s'ils manquent) ; annonces de file à la moitié des places puis à une place (10 min mini entre deux annonces d'une file, files de test ignorées) ; annonces GTA et rappel 1 h avant (DM aux inscrits).
- **Notifications push** (`services/push.ts`, `/push/*`) : match trouvé, rappels GTA et nouvel événement GTA (aux joueurs déjà inscrits à un événement) envoyés aux appareils abonnés, même site fermé ; abonnements refusés (404/410) supprimés, 10 appareils max par joueur.
- **Départ du site** : un joueur sans connexion WebSocket quitte la file (avec son groupe) après 30 s sur ordinateur, `COD_MOBILE_GRACE_MINUTES` (30 min) sur téléphone (écran verrouillé, autre appli) ; une notification push « Recherche arrêtée » prévient les joueurs concernés.
- **Durée maximale de recherche** (`services/queuePolicy.ts`, testée) : 30 min (`COD_QUEUE_MAX_MINUTES`) depuis la dernière confirmation (`cod_queue.confirmed_at`) ; « Toujours là ? » 5 min avant (`warned_at`, notification push) ; `POST /cod/queue/stay` relance le compteur sans changer `joined_at` (place conservée) ; sans réponse, le groupe sort de la file avec une notification.
- **Surveillance des erreurs** : erreurs 500, promesses non gérées et exceptions (suivies d'un redémarrage) signalées dans `DISCORD_ALERTS_CHANNEL_ID` (sinon `DISCORD_STAFF_CHANNEL_ID`) ; le site envoie les siennes à `POST /errors` (public, 10/min par adresse, bruit des navigateurs ignoré). Une alerte par erreur toutes les 15 min, 20 par heure au plus, sans données personnelles.
- Un résultat déclaré est validé d'office après 15 min sans réponse ; un match jamais déclaré est annulé après 3 h.

## Routes

Publiques : `GET /health`, `GET /stats`, `POST /errors`, `GET /cod/status`, `GET /cod/matches/:id` (chat et preuves seulement pour les joueurs du match et les admins, jeton facultatif), `GET /gta/events`, `GET /gta/events/:id`.

Connexion Discord requise (`Authorization: Bearer <jeton Supabase>`) : `GET /cod/queue`, `POST /cod/queue/join|leave|stay`, `GET|POST /cod/party`, `POST /cod/party/join|leave|kick|format`, `GET /cod/matches/:id/me`, `POST /cod/matches/:id/mvp|arbitration`, `POST /cod/reports`, `POST /cod/matches/:id/ready|report|confirm|messages|proofs`, `POST|DELETE /gta/events/:id/register`.

Admin (`users.role = 'admin'`) : `POST /cod/matches/:id/resolve`, `POST /gta/events`, et tout `/admin/*` (voir l'en-tête de `src/routes/admin.ts`).

Erreurs : `{ "error": { "code": "EVENT_FULL", "message": "..." } }`.

## Variables d'environnement

Voir `.env.example`. Indispensables : `SUPABASE_URL` et la clé secrète `SUPABASE_SERVICE_ROLE_KEY` (l'ancien nom `SUPABASE_KEY` est accepté). Optionnelles : `CORS_ORIGINS`, `COD_FORMATS`, `COD_TEAM_SIZE`, `COD_MAPS`, `COD_MODES`, `COD_CONFIRM_MINUTES`, `COD_CANCEL_MINUTES`, `COD_READY_SECONDS`, `COD_MOBILE_GRACE_MINUTES` (30 par défaut), `COD_QUEUE_MAX_MINUTES` (30 par défaut), `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_MATCH_CATEGORY_ID`, `DISCORD_RESULTS_CHANNEL_ID`, `DISCORD_STAFF_CHANNEL_ID`, `DISCORD_ALERTS_CHANNEL_ID`, `DISCORD_COD_CHANNEL_ID`, `DISCORD_GTA_CHANNEL_ID`, `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (sinon générées et gardées en base), `SITE_URL`.

Une vérification automatique (`.github/workflows/ci.yml`) compile le projet à chaque PR.

Ne jamais committer `.env`, `node_modules/` ni `dist/` (voir `.gitignore`).

## Conventions

- Code et commentaires en français.
- Une seule instance Render : les connexions WebSocket et le limiteur de débit vivent en mémoire.
