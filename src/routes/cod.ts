import { Router } from 'express';
import { currentUser, requireAdmin, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { HttpError, asyncHandler, uuidParam } from '../errors.js';
import { bus } from '../events.js';
import { notifyStaff } from '../services/discord.js';
import { ARBITRATION_REASONS, REPORT_REASONS, myArbitrations, reportPlayer, requestArbitration, usernameOf, voteMvp } from '../services/moderation.js';
import { supabase } from '../supabase.js';
import { addProof, confirmMatch, getMatch, postMessage, readyMatch, reportMatch, resolveMatch } from '../services/matches.js';
import { createParty, getPartyOf, joinParty, kickMember, leaveParty, previewInvite, setPartyFormat } from '../services/parties.js';
import { getQueueState, getQueueSummaries, joinQueue, leaveQueue } from '../services/queue.js';
import { getSiteStats } from '../services/stats.js';
import type { QueueHub } from '../ws/hub.js';

/**
 * Endpoints du classé COD.
 *
 * Publics (le site est visible sans connexion) :
 *   GET  /cod/status                compteurs de la page Ranked (files, matchs, joueurs en ligne)
 *   GET  /cod/matches/:id           détail d'un match, de ses joueurs et de son chat
 *   GET  /cod/party/invite/:code    aperçu d'une invitation de groupe (chef, format, places)
 *
 * Connexion Discord requise :
 *   GET  /cod/queue                 état de la file et du groupe pour le joueur
 *   POST /cod/queue/join            entrer dans la file { format } (seul) ; un chef y fait entrer tout son groupe
 *   POST /cod/queue/leave           quitter la file (avec tout son groupe)
 *   GET  /cod/party                 mon groupe
 *   POST /cod/party                 créer un groupe          { format }
 *   POST /cod/party/join            rejoindre un groupe      { code }
 *   POST /cod/party/leave           quitter son groupe
 *   POST /cod/party/kick            retirer un membre (chef) { userId }
 *   POST /cod/party/format          changer de format (chef) { format }
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
      const [queues, stats] = await Promise.all([getQueueSummaries(), getSiteStats()]);
      res.json({
        queues,
        playersInQueue: queues.reduce((sum, queue) => sum + queue.size, 0),
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
    asyncHandler(async (req, res) => {
      const user = currentUser(res);
      // Le match trouvé est annoncé par WebSocket : chaque membre doit avoir le site
      // ouvert, sinon il occuperait une place sans jamais être prévenu.
      const format = (req.body as { format?: unknown } | undefined)?.format;
      await joinQueue(user.id, format, (id) => hub.isConnected(id));
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

  // --- Groupes -----------------------------------------------------------------

  router.get(
    '/party/invite/:code',
    asyncHandler(async (req, res) => {
      res.json(await previewInvite(String(req.params.code ?? '')));
    }),
  );

  router.get(
    '/party',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.json({ party: await getPartyOf(currentUser(res).id) });
    }),
  );

  router.post(
    '/party',
    requireAuth,
    asyncHandler(async (req, res) => {
      const format = (req.body as { format?: unknown } | undefined)?.format;
      res.status(201).json({ party: await createParty(currentUser(res).id, format) });
    }),
  );

  router.post(
    '/party/join',
    requireAuth,
    asyncHandler(async (req, res) => {
      const code = (req.body as { code?: unknown } | undefined)?.code;
      res.json({ party: await joinParty(currentUser(res).id, code) });
    }),
  );

  router.post(
    '/party/leave',
    requireAuth,
    asyncHandler(async (_req, res) => {
      await leaveParty(currentUser(res).id);
      res.json({ party: null });
    }),
  );

  router.post(
    '/party/kick',
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = (req.body as { userId?: unknown } | undefined)?.userId;
      res.json({ party: await kickMember(currentUser(res).id, userId) });
    }),
  );

  router.post(
    '/party/format',
    requireAuth,
    asyncHandler(async (req, res) => {
      const format = (req.body as { format?: unknown } | undefined)?.format;
      res.json({ party: await setPartyFormat(currentUser(res).id, format) });
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

  // --- MVP, arbitrage, signalements -------------------------------------------

  router.get(
    '/matches/:id/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const matchId = uuidParam(req, 'id');
      const userId = currentUser(res).id;
      const [vote, arbitrations] = await Promise.all([
        supabase.from('cod_mvp_votes').select('target_id').eq('match_id', matchId).eq('voter_id', userId).maybeSingle(),
        myArbitrations(matchId, userId),
      ]);
      res.json({ myVote: (vote.data as { target_id: string } | null)?.target_id ?? null, arbitrations });
    }),
  );

  router.post(
    '/matches/:id/mvp',
    requireAuth,
    asyncHandler(async (req, res) => {
      await voteMvp(uuidParam(req, 'id'), currentUser(res).id, (req.body as { targetId?: unknown } | undefined)?.targetId);
      res.json({ voted: true });
    }),
  );

  router.post(
    '/matches/:id/arbitration',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(res);
      const matchId = uuidParam(req, 'id');
      const request = await requestArbitration(matchId, user.id, req.body);
      void notifyStaff(
        `🛡️ **Demande d'arbitrage** — ${ARBITRATION_REASONS[request.reason]}\n` +
          `Par ${await usernameOf(user.id)}${request.details ? ` : « ${request.details} »` : ''}\n` +
          `${config.siteUrl}/cod/match/${matchId} · ${config.siteUrl}/admin?onglet=arbitrages`,
      );
      res.status(201).json({ request });
    }),
  );

  router.post(
    '/reports',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(res);
      const report = await reportPlayer(user.id, req.body);
      void notifyStaff(
        `🚩 **Signalement** — ${REPORT_REASONS[report.reason]} : ${await usernameOf(report.target_id)}\n` +
          `Par ${await usernameOf(user.id)}${report.details ? ` : « ${report.details} »` : ''}\n` +
          `${config.siteUrl}/admin?onglet=signalements`,
      );
      res.status(201).json({ reported: true });
    }),
  );

  return router;
}
