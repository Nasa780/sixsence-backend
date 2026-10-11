import { Router } from 'express';
import { currentUser, requireAdmin, requireAuth } from '../auth.js';
import { playersNeeded } from '../config.js';
import { HttpError, asyncHandler, uuidParam } from '../errors.js';
import { bus } from '../events.js';
import { addProof, confirmMatch, getMatch, postMessage, readyMatch, reportMatch, resolveMatch } from '../services/matches.js';
import { getQueueSize, getQueueState, joinQueue, leaveQueue } from '../services/queue.js';
import { getSiteStats } from '../services/stats.js';
import type { QueueHub } from '../ws/hub.js';

/**
 * Endpoints du classé COD.
 *
 * Publics (le site est visible sans connexion) :
 *   GET  /cod/status                compteurs de la page Ranked (file, matchs, joueurs en ligne)
 *   GET  /cod/matches/:id           détail d'un match, de ses joueurs et de son chat
 *
 * Connexion Discord requise :
 *   GET  /cod/queue                 état de la file pour le joueur
 *   POST /cod/queue/join            entrer dans la file
 *   POST /cod/queue/leave           quitter la file
 *   POST /cod/matches/:id/ready     accepter le match trouvé (vérification « Prêt ? », 1 min)
 *   POST /cod/matches/:id/proofs    enregistrer une capture déjà envoyée { path }
 *   POST /cod/matches/:id/report    déclarer le vainqueur   { winner: "A" | "B" }
 *   POST /cod/matches/:id/confirm   confirmer ou contester  { accept: boolean }
 *   POST /cod/matches/:id/messages  écrire dans le chat     { body: string }
 *   POST /cod/matches/:id/resolve   arbitrage admin         { winner: "A" | "B" | null }
 */
export function codRouter(hub: QueueHub): Router {
  const router = Router();

  // --- Public ----------------------------------------------------------------

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const [playersInQueue, stats] = await Promise.all([getQueueSize(), getSiteStats()]);
      res.json({
        playersInQueue,
        needed: playersNeeded,
        matchesInProgress: stats.matchesInProgress,
        playersOnline: hub.onlineCount(),
      });
    }),
  );

  router.get(
    '/matches/:id',
    asyncHandler(async (req, res) => {
      res.json(await getMatch(uuidParam(req, 'id')));
    }),
  );

  // --- Connexion Discord requise ---------------------------------------------

  router.get(
    '/queue',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.json(await getQueueState(currentUser(res).id));
    }),
  );

  router.post(
    '/queue/join',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const user = currentUser(res);
      // Le match trouvé est annoncé par WebSocket : sans connexion ouverte, le
      // joueur occuperait une place sans jamais être prévenu.
      if (!hub.isConnected(user.id)) {
        throw new HttpError(409, 'SOCKET_REQUIRED', 'Connexion temps réel indisponible. Recharge la page et réessaie.');
      }
      await joinQueue(user.id);
      res.json(await getQueueState(user.id));
    }),
  );

  router.post(
    '/queue/leave',
    requireAuth,
    asyncHandler(async (_req, res) => {
      const user = currentUser(res);
      await leaveQueue(user.id);
      res.json(await getQueueState(user.id));
    }),
  );

  router.post(
    '/matches/:id/ready',
    requireAuth,
    asyncHandler(async (req, res) => {
      const match = await readyMatch(uuidParam(req, 'id'), currentUser(res).id);
      bus.emit(match.status === 'in_progress' && match.started_at && Date.now() - new Date(match.started_at).getTime() < 5000 ? 'match:start' : 'match:ready', match);
      res.json({ match });
    }),
  );

  router.post(
    '/matches/:id/proofs',
    requireAuth,
    asyncHandler(async (req, res) => {
      const path = (req.body as { path?: unknown } | undefined)?.path;
      if (typeof path !== 'string' || path.length > 300) {
        throw new HttpError(400, 'INVALID_PROOF', 'Fichier de preuve invalide.');
      }
      await addProof(uuidParam(req, 'id'), currentUser(res).id, path);
      res.status(201).json({ saved: true });
    }),
  );

  router.post(
    '/matches/:id/report',
    requireAuth,
    asyncHandler(async (req, res) => {
      const winner = (req.body as { winner?: unknown } | undefined)?.winner;
      if (winner !== 'A' && winner !== 'B') {
        throw new HttpError(400, 'INVALID_WINNER', 'Vainqueur invalide.');
      }
      res.json({ match: await reportMatch(uuidParam(req, 'id'), currentUser(res).id, winner) });
    }),
  );

  router.post(
    '/matches/:id/confirm',
    requireAuth,
    asyncHandler(async (req, res) => {
      const accept = (req.body as { accept?: unknown } | undefined)?.accept;
      if (typeof accept !== 'boolean') {
        throw new HttpError(400, 'INVALID_BODY', 'Le champ "accept" (true ou false) est requis.');
      }
      res.json({ match: await confirmMatch(uuidParam(req, 'id'), currentUser(res).id, accept) });
    }),
  );

  router.post(
    '/matches/:id/messages',
    requireAuth,
    asyncHandler(async (req, res) => {
      const body = (req.body as { body?: unknown } | undefined)?.body;
      if (typeof body !== 'string') {
        throw new HttpError(400, 'INVALID_MESSAGE', 'Le message doit contenir entre 1 et 300 caractères.');
      }
      await postMessage(uuidParam(req, 'id'), currentUser(res).id, body);
      res.status(201).json({ sent: true });
    }),
  );

  router.post(
    '/matches/:id/resolve',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const winner = (req.body as { winner?: unknown } | undefined)?.winner ?? null;
      if (winner !== 'A' && winner !== 'B' && winner !== null) {
        throw new HttpError(400, 'INVALID_WINNER', 'Vainqueur invalide.');
      }
      res.json({ match: await resolveMatch(uuidParam(req, 'id'), winner) });
    }),
  );

  return router;
}
