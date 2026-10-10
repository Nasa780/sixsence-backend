import { createServer } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { verifyAccessToken } from './auth.js';
import { config, isOriginAllowed, playersNeeded } from './config.js';
import { asyncHandler, errorHandler, notFoundHandler } from './errors.js';
import { bus } from './events.js';
import { rateLimit } from './rateLimit.js';
import { codRouter } from './routes/cod.js';
import { gtaRouter } from './routes/gta.js';
import { sweepMatches } from './services/matches.js';
import { clearQueue, getQueueSize, getQueueState, leaveQueue } from './services/queue.js';
import { getSiteStats } from './services/stats.js';
import { QueueHub } from './ws/hub.js';

/**
 * Point d'entrée du backend SixSence (hébergé sur Render).
 *
 *   HTTP       /health, /stats, /cod/*, /gta/*   (voir routes/)
 *   WebSocket  /ws                               (voir ws/hub.ts)
 */

// --- WebSocket ---------------------------------------------------------------

const hub = new QueueHub({
  authenticate: verifyAccessToken,
  getState: async (userId) => ({ ...(await getQueueState(userId)) }),
  // Joueur parti sans revenir : on libère sa place dans la file.
  onUserGone: (userId) => leaveQueue(userId),
  isOriginAllowed,
  graceMs: config.cod.disconnectGraceMs,
});

// Les services émettent des événements ; on les relaie aux navigateurs.
bus.on('queue:changed', async () => {
  hub.broadcast({ type: 'queue:update', size: await getQueueSize(), needed: playersNeeded });
});
bus.on('queue:user', async (userId) => {
  const state = await getQueueState(userId);
  hub.sendToUser(userId, { type: 'queue:state', inQueue: state.inQueue, joinedAt: state.joinedAt });
});
bus.on('match:found', (match) => {
  hub.sendToUsers([...match.team_a, ...match.team_b], {
    type: 'match:found',
    matchId: match.id,
    map: match.map,
    mode: match.mode,
  });
});

// --- HTTP --------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// Render place un proxy devant l'application : nécessaire pour lire la vraie IP du client.
app.set('trust proxy', 1);

app.use(
  cors({
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }),
);
app.use(express.json({ limit: '10kb' }));
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

server.listen(config.port, () => {
  console.log(`[boot] SixSence API en écoute sur le port ${config.port}`);
  console.log(`[boot] classé COD en ${config.cod.teamSize}v${config.cod.teamSize}, origines : ${config.corsOrigins.join(', ')}`);
});

// Arrêt propre : Render envoie SIGTERM à chaque redéploiement.
function shutdown(signal: string): void {
  console.log(`[boot] ${signal} reçu, arrêt en cours`);
  clearInterval(sweeper);
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
