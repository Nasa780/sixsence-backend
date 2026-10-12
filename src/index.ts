import { createServer } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { verifyAccessToken } from './auth.js';
import { config, isOriginAllowed } from './config.js';
import { asyncHandler, errorHandler, notFoundHandler } from './errors.js';
import { bus } from './events.js';
import { rateLimit } from './rateLimit.js';
import { adminRouter } from './routes/admin.js';
import { codRouter } from './routes/cod.js';
import { gtaRouter } from './routes/gta.js';
import { discordEnabled, onMatchFound, onMatchStart, sweepDiscord } from './services/discord.js';
import { sweepMatches } from './services/matches.js';
import { awardPreviousMonthMvp, usernameOf } from './services/moderation.js';
import { announceMonthlyMvp, onQueueChanged, sendEventReminders, syncAllRankRoles, syncRankRoles } from './services/community.js';
import { clearQueue, expireReadyChecks, getQueueState, getQueueSummaries, leaveQueue } from './services/queue.js';
import { getSiteStats } from './services/stats.js';
import { QueueHub } from './ws/hub.js';

/**
 * Point d'entrée du backend SixSence (hébergé sur Render).
 *
 *   HTTP       /health, /stats, /cod/*, /gta/*, /admin/*   (voir routes/)
 *   WebSocket  /ws                               (voir ws/hub.ts)
 */

// --- WebSocket ---------------------------------------------------------------

const hub = new QueueHub({
  authenticate: verifyAccessToken,
  getState: async (userId) => ({ ...(await getQueueState(userId)) }),
  // Joueur parti sans revenir : on libère sa place dans la file (avec son groupe).
  onUserGone: (userId) => leaveQueue(userId, 'Un membre du groupe a fermé le site : recherche annulée.'),
  isOriginAllowed,
  graceMs: config.cod.disconnectGraceMs,
});

// Les services émettent des événements ; on les relaie aux navigateurs.
bus.on('queue:changed', async () => {
  const queues = await getQueueSummaries();
  hub.broadcast({ type: 'queue:update', queues });
  onQueueChanged(queues);
});
// Rangs Discord des joueurs à jour après chaque match.
bus.on('match:finalized', (match) => {
  void syncRankRoles([...match.team_a, ...match.team_b]);
});
bus.on('queue:user', async (userId) => {
  const state = await getQueueState(userId);
  hub.sendToUser(userId, {
    type: 'queue:state',
    inQueue: state.inQueue,
    format: state.format,
    groupSize: state.groupSize,
    joinedAt: state.joinedAt,
  });
});
bus.on('party:changed', (party, alsoNotify) => {
  if (party) hub.sendToUsers(party.members.map((member) => member.id), { type: 'party:update', party });
  hub.sendToUsers(alsoNotify, { type: 'party:update', party: null });
});
bus.on('notice', (userIds, message) => {
  hub.sendToUsers(userIds, { type: 'notice', message });
});
bus.on('match:found', (match) => {
  hub.sendToUsers([...match.team_a, ...match.team_b], {
    type: 'match:found',
    matchId: match.id,
    format: match.format,
    map: match.map,
    mode: match.mode,
    deadline: match.ready_deadline,
    total: match.team_size * 2,
  });
  void onMatchFound(match);
});
bus.on('match:ready', (match) => {
  hub.sendToUsers([...match.team_a, ...match.team_b], {
    type: 'match:ready',
    matchId: match.id,
    accepted: match.ready_users.length,
    total: match.team_size * 2,
    readyUsers: match.ready_users,
  });
});
bus.on('match:start', (match) => {
  hub.sendToUsers([...match.team_a, ...match.team_b], { type: 'match:start', matchId: match.id });
  void onMatchStart(match);
});
// Match terminé : salons vocaux supprimés et résultat publié tout de suite (sans attendre la tâche périodique).
bus.on('match:closed', () => sweepDiscord());

bus.on('match:aborted', async (failure) => {
  // Ceux qui avaient accepté sont remis en tête de file ; les absents sont sanctionnés.
  for (const userId of failure.accepted) {
    hub.sendToUser(userId, { type: 'match:aborted', matchId: failure.match_id, reason: 'requeued' });
    bus.emit('queue:user', userId);
  }
  // Avaient accepté, mais un coéquipier manquait : ils restent groupés, hors file.
  for (const userId of failure.released ?? []) {
    hub.sendToUser(userId, { type: 'match:aborted', matchId: failure.match_id, reason: 'released' });
    bus.emit('queue:user', userId);
  }
  for (const userId of failure.missing) {
    const state = await getQueueState(userId);
    hub.sendToUser(userId, { type: 'match:aborted', matchId: failure.match_id, reason: 'missed', bannedUntil: state.bannedUntil });
  }
});

// --- HTTP --------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// Render place un proxy devant l'application : nécessaire pour lire la vraie IP du client.
app.set('trust proxy', 1);

app.use(
  cors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
);
app.use(express.json({ limit: '32kb' }));
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Sonde de santé : utilisée par Render pour savoir si le service est vivant.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.use(rateLimit(120, 60_000));

// Compteurs publics de la page d'accueil.
app.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    res.json(await getSiteStats());
  }),
);

app.use('/cod', codRouter(hub));
app.use('/gta', gtaRouter());
app.use('/admin', adminRouter());
app.use(notFoundHandler);
app.use(errorHandler);

const server = createServer(app);
hub.attach(server);

// --- Démarrage ---------------------------------------------------------------

// Après un redémarrage plus personne n'est connecté : la file repart de zéro.
// Les navigateurs encore ouverts se reconnectent seuls et affichent "hors file".
clearQueue().catch((error) => console.error('[boot] purge de la file impossible', error));

// Ménage des matchs sans réponse ou abandonnés, une fois par minute.
const sweeper = setInterval(() => void sweepMatches(), 60_000);
// Vérifications « Prêt ? » expirées : contrôlées toutes les 3 secondes.
const readyTimer = setInterval(() => void expireReadyChecks(), 3_000);
// Discord : suppression des salons vocaux et publication des résultats.
const discordTimer = setInterval(() => void sweepDiscord(), 30_000);
// MVP du mois : attribué dès le début du mois suivant (vérifié au démarrage puis toutes les heures).
const awardMvp = () =>
  awardPreviousMonthMvp()
    .then(async (award) => {
      if (!award) return;
      console.log(`[mvp] MVP du mois ${award.month.slice(0, 7)} : ${award.userId}`);
      await announceMonthlyMvp(await usernameOf(award.userId), award.month);
    })
    .catch((error) => console.error('[mvp]', error));
void awardMvp();
const mvpTimer = setInterval(awardMvp, 60 * 60_000);
// Rappels Discord 1 h avant les événements GTA 6.
const reminderTimer = setInterval(() => void sendEventReminders(), 5 * 60_000);
// Rôles Discord de tous les joueurs classés, une fois au démarrage.
setTimeout(() => void syncAllRankRoles().then((count) => count && console.log(`[discord] rôles mis à jour pour ${count} joueur(s)`)), 20_000);

server.listen(config.port, () => {
  console.log(`[boot] SixSence API en écoute sur le port ${config.port}`);
  console.log(`[boot] files : ${config.cod.formats.map((format) => format.label).join(', ')} · origines : ${config.corsOrigins.join(', ')}`);
  console.log(`[boot] vérification « Prêt ? » : ${config.cod.readySeconds} s · Discord : ${discordEnabled ? 'activé' : 'désactivé'}`);
});

// Arrêt propre : Render envoie SIGTERM à chaque redéploiement.
function shutdown(signal: string): void {
  console.log(`[boot] ${signal} reçu, arrêt en cours`);
  clearInterval(sweeper);
  clearInterval(readyTimer);
  clearInterval(discordTimer);
  clearInterval(mvpTimer);
  clearInterval(reminderTimer);
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
