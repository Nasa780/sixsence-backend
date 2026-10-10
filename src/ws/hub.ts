import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

/**
 * Hub WebSocket de la file d'attente.
 *
 * Protocole (messages JSON) :
 *
 *   navigateur -> serveur
 *     { type: "auth", token }        premier message obligatoire (jeton de session)
 *     { type: "ping" }               garde la connexion ouverte
 *
 *   serveur -> navigateur
 *     { type: "ready", size, needed, inQueue, joinedAt, activeMatchId }
 *     { type: "queue:update", size, needed }       la file a bougé (envoyé à tous)
 *     { type: "queue:state", inQueue, joinedAt }   ton propre état a changé
 *     { type: "match:found", matchId, map, mode }  ton match est prêt
 *     { type: "error", code, message }
 *     { type: "pong" }
 *
 * Le jeton voyage dans un message et non dans l'URL : les URL finissent dans
 * les journaux des proxys, pas le contenu des messages.
 *
 * Le hub ne connaît ni Supabase ni les règles du jeu : tout lui est fourni
 * par HubDeps, ce qui le rend simple à tester isolément.
 */

export interface HubDeps {
  /** Vérifie un jeton et renvoie le joueur, ou null. */
  authenticate(token: string): Promise<{ id: string } | null>;
  /** État complet envoyé à un joueur juste après son authentification. */
  getState(userId: string): Promise<Record<string, unknown>>;
  /** Appelé quand un joueur n'a plus aucune connexion depuis graceMs. */
  onUserGone(userId: string): Promise<unknown>;
  isOriginAllowed(origin: string | undefined): boolean;
  /** Délai de grâce après la dernière déconnexion d'un joueur. */
  graceMs: number;
  /** Délai accordé pour envoyer le message "auth" (10 s par défaut). */
  authTimeoutMs?: number;
  /** Intervalle des pings de surveillance (30 s par défaut). */
  heartbeatMs?: number;
}

export type ServerMessage = { type: string } & Record<string, unknown>;

interface ClientState {
  userId: string | null;
  authenticating: boolean;
  alive: boolean;
  authTimer: NodeJS.Timeout | null;
  /** Compteur anti-abus : messages reçus dans la fenêtre en cours. */
  messageCount: number;
  windowStart: number;
}

const MAX_SOCKETS_PER_USER = 5;
const MAX_MESSAGES_PER_WINDOW = 30;
const MESSAGE_WINDOW_MS = 10_000;

export class QueueHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  private readonly clients = new Map<WebSocket, ClientState>();
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HubDeps) {
    this.wss.on('connection', (socket: WebSocket) => this.onConnection(socket));
  }

  /** Branche le hub sur le serveur HTTP : seules les requêtes vers /ws sont acceptées. */
  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const { pathname } = new URL(request.url ?? '/', 'http://localhost');
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      if (!this.deps.isOriginAllowed(request.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws, request));
    });

    // Surveillance : une connexion qui ne répond plus au ping est fermée.
    // Les pings empêchent aussi les proxys de couper une connexion silencieuse.
    this.heartbeat = setInterval(() => {
      for (const [socket, state] of this.clients) {
        if (!state.alive) {
          socket.terminate();
          continue;
        }
        state.alive = false;
        socket.ping();
      }
    }, this.deps.heartbeatMs ?? 30_000);
  }

  /** Ferme proprement toutes les connexions (arrêt du serveur). */
  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    for (const [socket, state] of this.clients) {
      if (state.authTimer) clearTimeout(state.authTimer);
      socket.close(1001, 'Arrêt du serveur');
    }
    this.wss.close();
  }

  /** Vrai si le joueur a au moins une connexion ouverte et authentifiée. */
  isConnected(userId: string): boolean {
    return (this.socketsByUser.get(userId)?.size ?? 0) > 0;
  }

  /** Nombre de joueurs connectés (un joueur avec plusieurs onglets compte une fois). */
  onlineCount(): number {
    return this.socketsByUser.size;
  }

  /** Envoie un message à tous les joueurs authentifiés. */
  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const [socket, state] of this.clients) {
      if (state.userId && socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  /** Envoie un message à toutes les connexions d'un joueur (plusieurs onglets possibles). */
  sendToUser(userId: string, message: ServerMessage): void {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return;
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  sendToUsers(userIds: string[], message: ServerMessage): void {
    for (const userId of userIds) this.sendToUser(userId, message);
  }

  // ---------------------------------------------------------------------------

  private onConnection(socket: WebSocket): void {
    const state: ClientState = {
      userId: null,
      authenticating: false,
      alive: true,
      authTimer: null,
      messageCount: 0,
      windowStart: Date.now(),
    };
    this.clients.set(socket, state);

    // Une connexion qui ne s'authentifie pas rapidement est fermée.
    state.authTimer = setTimeout(() => {
      if (!state.userId) socket.close(4401, 'Authentification attendue');
    }, this.deps.authTimeoutMs ?? 10_000);

    socket.on('pong', () => {
      state.alive = true;
    });
    socket.on('message', (raw: RawData) => {
      this.onMessage(socket, state, raw).catch((error) => {
        console.error('[ws] message', error);
        this.send(socket, { type: 'error', code: 'INTERNAL_ERROR', message: 'Erreur interne.' });
      });
    });
    socket.on('close', () => this.onClose(socket, state));
    socket.on('error', (error: Error) => console.error('[ws] socket', error.message));
  }

  private async onMessage(socket: WebSocket, state: ClientState, raw: RawData): Promise<void> {
    // Anti-abus : un client légitime n'envoie qu'un message toutes les ~25 secondes.
    const now = Date.now();
    if (now - state.windowStart > MESSAGE_WINDOW_MS) {
      state.windowStart = now;
      state.messageCount = 0;
    }
    state.messageCount += 1;
    if (state.messageCount > MAX_MESSAGES_PER_WINDOW) {
      socket.close(4429, 'Trop de messages');
      return;
    }

    let message: { type?: unknown; token?: unknown };
    try {
      message = JSON.parse(raw.toString()) as typeof message;
    } catch {
      return; // message illisible : ignoré
    }
    if (typeof message !== 'object' || message === null) return;

    if (message.type === 'ping') {
      this.send(socket, { type: 'pong' });
      return;
    }

    if (message.type === 'auth' && typeof message.token === 'string' && !state.userId && !state.authenticating) {
      state.authenticating = true;
      const user = await this.deps.authenticate(message.token).catch(() => null);
      state.authenticating = false;

      // La connexion a pu être fermée pendant la vérification du jeton.
      if (socket.readyState !== WebSocket.OPEN) return;

      if (!user) {
        this.send(socket, { type: 'error', code: 'UNAUTHORIZED', message: 'Connexion Discord requise.' });
        socket.close(4401, 'Jeton invalide');
        return;
      }

      const sockets = this.socketsByUser.get(user.id) ?? new Set<WebSocket>();
      if (sockets.size >= MAX_SOCKETS_PER_USER) {
        socket.close(4429, 'Trop de connexions');
        return;
      }

      state.userId = user.id;
      if (state.authTimer) clearTimeout(state.authTimer);
      state.authTimer = null;
      sockets.add(socket);
      this.socketsByUser.set(user.id, sockets);

      // Le joueur est revenu avant la fin du délai de grâce : il garde sa place.
      const grace = this.graceTimers.get(user.id);
      if (grace) {
        clearTimeout(grace);
        this.graceTimers.delete(user.id);
      }

      const snapshot = await this.deps.getState(user.id);
      this.send(socket, { type: 'ready', ...snapshot });
    }
  }

  private onClose(socket: WebSocket, state: ClientState): void {
    if (state.authTimer) clearTimeout(state.authTimer);
    this.clients.delete(socket);

    const userId = state.userId;
    if (!userId) return;

    const sockets = this.socketsByUser.get(userId);
    sockets?.delete(socket);
    if (sockets && sockets.size > 0) return; // il lui reste un autre onglet ouvert
    this.socketsByUser.delete(userId);

    // Dernière connexion fermée : on laisse au joueur le temps de revenir
    // (rechargement de page, micro-coupure) avant de libérer sa place.
    const timer = setTimeout(() => {
      this.graceTimers.delete(userId);
      if (this.isConnected(userId)) return;
      this.deps.onUserGone(userId).catch((error) => console.error('[ws] onUserGone', error));
    }, this.deps.graceMs);
    this.graceTimers.set(userId, timer);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}
