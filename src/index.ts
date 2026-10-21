import { createServer } from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { verifyAccessToken } from './auth.js';
import { config, isOriginAllowed } from './config.js';
import { asyncHandler, errorHandler, isUnexpected, notFoundHandler } from './errors.js';
import { bus } from './events.js';
import { rateLimit } from './rateLimit.js';
import { isVisitorId, markPresent, onlineVisitors } from './services/presence.js';
import { postDailyReport, recordVisit } from './services/siteLog.js';
import { adminRouter } from './routes/admin.js';
import { codRouter } from './routes/cod.js';
import { errorsRouter } from './routes/errors.js';
import { gtaRouter } from './routes/gta.js';
import { pushRouter } from './routes/push.js';
import { teamsRouter } from './routes/teams.js';
import { describeError, reportError } from './services/alerts.js';
import { discordEnabled, onMatchFound, onMatchStart, sweepDiscord } from './services/discord.js';
import { commandsEnabled, handleInteraction, registerCommands, validSignature } from './services/discordCommands.js';
import { pointsPreview, sweepMatches } from './services/matches.js';
import { checkTeamQueueTimeouts, sweepTeamMatches, tryCreateTeamMatches } from './services/teamMatches.js';
import { sweepTournaments } from './services/tournaments.js';
import { awardPreviousMonthMvp, usernameOf } from './services/moderation.js';
import { announceMonthlyMvp, announcePromotions, onMonthlyMvp, onQueueChanged, postWeeklyTop, sendEventReminders, syncAllRankRoles, syncRankRoles, syncTeamAndBadgeRoles, welcomeNewPlayers } from './services/community.js';
import { checkQueueTimeouts, clearQueue, expireReadyChecks, getQueueState, getQueueSummaries, leaveQueue } from './services/queue.js';
import { getSiteStats } from './services/stats.js';
import { calendarEvents, calendarIcs } from './services/calendar.js';
import { globalSearch } from './services/search.js';
import { pushPublicKey, pushToUsers } from './services/push.js';
import { noticeMatchAbandoned, noticeMatchFinished, noticeMatchMissed, remindStaff } from './services/matchNotices.js';
import { syncAllCards, syncCards } from './services/cards.js';
import { supabase } from './supabase.js';
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
  // Joueur parti sans revenir : on libère sa place dans la file (avec son groupe)
  // et on prévient par notification ceux dont la recherche s'arrête.
  onUserGone: async (userId) => {
    const removed = await leaveQueue(userId, 'Un membre du groupe a quitté le site : recherche annulée.');
    if (removed.length === 0) return;
    void pushToUsers([userId], {
      title: 'Recherche arrêtée',
      body: `Tu n'es plus sur SixSence depuis ${config.cod.mobileGraceMinutes} min : ta recherche est arrêtée. Touche ici pour la relancer.`,
      url: '/cod/ranked',
      tag: 'file',
    });
    void pushToUsers(
      removed.filter((member) => member !== userId),
      {
        title: 'Recherche du groupe arrêtée',
        body: "Un membre de ton groupe n'est plus sur SixSence : votre recherche est arrêtée. Touche ici pour la relancer.",
        url: '/cod/ranked',
        tag: 'file',
      },
    );
  },
  isOriginAllowed,
  // Même délai sur ordinateur et téléphone (30 min par défaut, COD_MOBILE_GRACE_MINUTES).
  graceMs: config.cod.mobileGraceMinutes * 60_000,
});

// Les services émettent des événements ; on les relaie aux navigateurs.
bus.on('queue:changed', async () => {
  const queues = await getQueueSummaries();
  hub.broadcast({ type: 'queue:update', queues });
  onQueueChanged(queues);
});
// Rangs Discord des joueurs à jour après chaque match, et résultat envoyé à chacun.
bus.on('match:finalized', (match) => {
  void syncRankRoles([...match.team_a, ...match.team_b]);
  void noticeMatchFinished(match);
  void announcePromotions(match);
  for (const userId of [...match.team_a, ...match.team_b]) void syncCards(userId).catch(() => {});
});
bus.on('match:abandoned', (match) => void noticeMatchAbandoned(match));
bus.on('queue:user', async (userId) => {
  const state = await getQueueState(userId);
  hub.sendToUser(userId, {
    type: 'queue:state',
    inQueue: state.inQueue,
    format: state.format,
    groupSize: state.groupSize,
    joinedAt: state.joinedAt,
    expiresAt: state.expiresAt,
    stillThere: state.stillThere,
  });
});
// Durée maximale de recherche : « Toujours là ? » puis arrêt, avec notification.
bus.on('queue:warned', (userIds) => {
  void pushToUsers(userIds, {
    title: 'Toujours là ?',
    body: `Aucun match pour l'instant : ta recherche s'arrête dans ${config.cod.queueWarnMinutes} min. Touche ici pour rester en file.`,
    url: '/cod/ranked',
    tag: 'file',
    urgent: true,
  });
});
bus.on('queue:expired', (userIds) => {
  void pushToUsers(userIds, {
    title: 'Recherche arrêtée',
    body: `Aucun match trouvé en ${config.cod.queueMaxMinutes} min. Touche ici pour relancer une recherche.`,
    url: '/cod/ranked',
    tag: 'file',
  });
});
bus.on('party:changed', (party, alsoNotify) => {
  if (party) hub.sendToUsers(party.members.map((member) => member.id), { type: 'party:update', party });
  hub.sendToUsers(alsoNotify, { type: 'party:update', party: null });
});
bus.on('notice', (userIds, message) => {
  hub.sendToUsers(userIds, { type: 'notice', message });
});
bus.on('match:found', async (match) => {
  // Chaque joueur reçoit ses propres points en jeu (« Victoire +35 · Défaite -9 »).
  const stakes = await pointsPreview(match.id);
  for (const userId of [...match.team_a, ...match.team_b]) {
    hub.sendToUser(userId, {
      type: 'match:found',
      matchId: match.id,
      format: match.format,
      map: match.map,
      mode: match.mode,
      deadline: match.ready_deadline,
      total: match.team_size * 2,
      points: stakes[userId] ?? null,
    });
  }
  void onMatchFound(match);
  // Notification sur téléphone / ordinateur, même site fermé (appli installée).
  void pushToUsers([...match.team_a, ...match.team_b], {
    title: '⚡ Match trouvé !',
    body: `${match.format ?? ''} · ${match.map} — accepte dans la minute.`,
    url: `/cod/match/${match.id}`,
    tag: `match-${match.id}`,
    urgent: true,
  });
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
    void noticeMatchMissed(userId, state.bannedUntil);
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
// Commandes Discord du bot : corps brut, nécessaire pour vérifier la signature de Discord.
app.post('/discord/interactions', express.raw({ type: '*/*', limit: '64kb' }), (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!commandsEnabled || !validSignature(raw, req.header('x-signature-ed25519'), req.header('x-signature-timestamp'))) {
    res.status(401).send('Signature invalide');
    return;
  }
  try {
    res.json(handleInteraction(JSON.parse(raw.toString('utf8'))));
  } catch {
    res.status(400).send('Requête invalide');
  }
});
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

// Présence sur le site (compteur « En ligne maintenant ») : un signal toutes les 45 s par onglet ouvert.
app.post('/presence', (req: Request, res: Response) => {
  const id = (req.body as { id?: unknown } | undefined)?.id;
  if (isVisitorId(id)) {
    markPresent(id);
    recordVisit(id);
  }
  res.json({ online: onlineVisitors() });
});

// Recherche globale (joueurs et équipes), pendant la frappe : 60 requêtes par minute et par adresse.
app.get(
  '/search',
  rateLimit(60, 60_000),
  asyncHandler(async (req, res) => {
    res.json(await globalSearch(typeof req.query.q === 'string' ? req.query.q : ''));
  }),
);

// Calendrier public : coupes, événements GTA 6, saison (JSON pour le site, .ics pour les agendas).
app.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    res.json({ events: await calendarEvents(req.query.from, req.query.to) });
  }),
);
app.get(
  '/calendar.ics',
  asyncHandler(async (_req, res) => {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sixsence.ics"');
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.send(await calendarIcs());
  }),
);

// Compteurs publics de la page d'accueil.
app.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    res.json(await getSiteStats());
  }),
);

if (config.localSafe) {
  app.use(/^\/cod\/(queue|party)/, (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') return next();
    res.status(403).json({ error: { code: 'LOCAL_SAFE', message: 'File et groupes du classé fermés en mode local.' } });
  });
}
app.use('/cod', codRouter(hub));
app.use('/gta', gtaRouter());
app.use('/push', pushRouter());
app.use('/teams', teamsRouter());
app.use('/admin', adminRouter());
app.use('/errors', errorsRouter());
app.use(notFoundHandler);
// Erreurs imprévues : signalées dans le salon Discord des alertes avant la réponse 500.
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (isUnexpected(error)) {
    const { message, stack } = describeError(error);
    reportError('serveur', message, { where: `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`, stack });
  }
  errorHandler(error, req, res, next);
});

const server = createServer(app);
hub.attach(server);

// --- Démarrage ---------------------------------------------------------------

// Après un redémarrage plus personne n'est connecté : la file repart de zéro.
// Les navigateurs encore ouverts se reconnectent seuls et affichent "hors file".
// (Pas en mode local : la base est celle du site en ligne, ses joueurs en file ne doivent pas en sortir.)
if (!config.localSafe) clearQueue().catch((error) => console.error('[boot] purge de la file impossible', error));
// Clés des notifications push (générées et gardées en base au premier démarrage).
void pushPublicKey();

// Ménage des matchs sans réponse ou abandonnés, une fois par minute.
const live = !config.localSafe; // mode local sans risque : aucune tâche du classé
const sweeper = live ? setInterval(() => void sweepMatches(), 60_000) : undefined;
// Matchs d'équipe : file (au cas où), scores non confirmés, matchs abandonnés, salons et résultats Discord ; tournois (départ, tableau).
const teamTimer = setInterval(() => {
  if (!config.teams.enabled) return; // Division en pause (TEAM_MODE)
  void tryCreateTeamMatches();
  void sweepTeamMatches();
  void sweepTournaments();
}, 60_000);
// Division : durée maximale de recherche (« Toujours là ? »), contrôlée toutes les 20 secondes.
const teamQueueTimer = setInterval(() => {
  if (config.teams.enabled) void checkTeamQueueTimeouts();
}, 20_000);
// Vérifications « Prêt ? » expirées : contrôlées toutes les 3 secondes.
const readyTimer = live ? setInterval(() => void expireReadyChecks(), 3_000) : undefined;
// Durée maximale de recherche : contrôlée toutes les 20 secondes.
const queueTimer = live ? setInterval(() => void checkQueueTimeouts(), 20_000) : undefined;
// Discord : suppression des salons vocaux et publication des résultats.
const discordTimer = live ? setInterval(() => void sweepDiscord(), 30_000) : undefined;
// MVP du mois : attribué dès le début du mois suivant (vérifié au démarrage puis toutes les heures).
const awardMvp = () =>
  awardPreviousMonthMvp()
    .then(async (award) => {
      if (!award) return;
      console.log(`[mvp] MVP du mois ${award.month.slice(0, 7)} : ${award.userId}`);
      await announceMonthlyMvp(await usernameOf(award.userId), award.month);
      await onMonthlyMvp(award.userId, award.month);
      await syncCards(award.userId);
    })
    .catch((error) => console.error('[mvp]', error));
if (live) void awardMvp();
const mvpTimer = live ? setInterval(awardMvp, 60 * 60_000) : undefined;
// Rappels Discord 1 h avant les événements GTA 6, et bienvenue aux nouveaux inscrits.
const reminderTimer = live
  ? setInterval(() => {
      void sendEventReminders();
      void welcomeNewPlayers();
    }, 5 * 60_000)
  : undefined;
// Cartes de visite : attribution rétroactive une seule fois (sans notification), puis
// rattrapage toutes les heures (événements GTA terminés, etc.).
if (live) setTimeout(() => {
  void (async () => {
    const { data: first } = await supabase.rpc('app_claim', { p_key: 'cards_backfill', p_value: 'v1' });
    const added = await syncAllCards({ silent: Boolean(first) });
    if (added) console.log(`[cartes] ${added} carte(s) attribuée(s)${first ? ' (attribution rétroactive)' : ''}`);
  })().catch((error) => console.warn('[cartes]', (error as Error).message));
}, 30_000);
const cardsTimer = live ? setInterval(() => void syncAllCards().catch(() => {}), 60 * 60_000) : undefined;
// Top de la semaine (lundi 10 h, heure de Paris) et relance de l'équipe (attente de plus de 2 h), vérifiés toutes les 15 minutes.
const weeklyTimer = live
  ? setInterval(() => {
      void postWeeklyTop();
      void remindStaff();
      void postDailyReport().catch((error) => console.warn('[journal]', (error as Error).message));
    }, 15 * 60_000)
  : undefined;
// Rôles Discord de tous les joueurs (rangs, équipe, badges, MVP du mois), une fois au démarrage.
if (live) setTimeout(
  () =>
    void syncAllRankRoles()
      .then((count) => count && console.log(`[discord] rôles de rang mis à jour pour ${count} joueur(s)`))
      .then(() => syncTeamAndBadgeRoles())
      .then((count) => count && console.log(`[discord] rôles d'équipe et de badges mis à jour pour ${count} joueur(s)`)),
  20_000,
);

server.listen(config.port, () => {
  console.log(`[boot] SixSence API en écoute sur le port ${config.port}`);
  console.log(`[boot] files : ${config.cod.formats.map((format) => format.label).join(', ')} · origines : ${config.corsOrigins.join(', ')}`);
  console.log(`[boot] vérification « Prêt ? » : ${config.cod.readySeconds} s · Discord : ${discordEnabled ? 'activé' : 'désactivé'}`);
  if (config.localSafe) console.log('[boot] MODE LOCAL SANS RISQUE : tâches du classé coupées, file et groupes du classé fermés');
  if (!config.localSafe) void registerCommands();
});

// Arrêt propre : Render envoie SIGTERM à chaque redéploiement.
function shutdown(signal: string): void {
  console.log(`[boot] ${signal} reçu, arrêt en cours`);
  clearInterval(sweeper);
  clearInterval(teamTimer);
  clearInterval(teamQueueTimer);
  clearInterval(weeklyTimer);
  clearInterval(cardsTimer);
  clearInterval(readyTimer);
  clearInterval(queueTimer);
  clearInterval(discordTimer);
  clearInterval(mvpTimer);
  clearInterval(reminderTimer);
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
// Erreurs hors requête : signalées. Une exception non rattrapée laisse le serveur dans un
// état incertain : on la signale puis on redémarre (Render relance le service).
process.on('unhandledRejection', (reason) => {
  const { message, stack } = describeError(reason);
  reportError('serveur', message, { where: 'promesse non gérée', stack });
});
process.on('uncaughtException', (error) => {
  const { message, stack } = describeError(error);
  reportError('serveur', message, { where: 'exception non rattrapée (redémarrage)', stack });
  setTimeout(() => process.exit(1), 2_000).unref();
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
