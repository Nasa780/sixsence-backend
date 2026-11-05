import { WebSocket, type RawData } from 'ws';
import { config } from '../config.js';
import { checkAuditAccess, onAuditEntry } from './discordModeration.js';
import type { AuditEntry } from './discordModerationPolicy.js';
import { onMemberAdd, onMemberRemove, syncMembers, type MemberEvent } from './discordMembers.js';
import { logToDiscord } from './siteLog.js';

/**
 * Connexion permanente du bot à Discord (Gateway), pour les seuls événements que l'API REST ne donne pas :
 * arrivées et départs du serveur, journal de modération. Reprise de session après une coupure, sinon reconnexion puis
 * rattrapage des membres (syncMembers).
 * Exige « Server Members Intent » dans le portail développeur, onglet Bot.
 */

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
/** GUILDS + GUILD_MEMBERS + GUILD_MODERATION. */
const INTENTS = (1 << 0) | (1 << 1) | (1 << 2);
const Op = { Dispatch: 0, Heartbeat: 1, Identify: 2, Resume: 6, Reconnect: 7, InvalidSession: 9, Hello: 10, HeartbeatAck: 11 } as const;
/** Fermetures sans espoir : jeton, intent ou version refusés. Inutile d'insister. */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;

interface Payload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

let socket: WebSocket | null = null;
let heartbeat: NodeJS.Timeout | undefined;
let firstBeat: NodeJS.Timeout | undefined;
let retry: NodeJS.Timeout | undefined;
let sequence: number | null = null;
let sessionId: string | null = null;
let botId: string | null = null;
let resumeUrl: string | null = null;
let acknowledged = true;
let retryMs = MIN_RETRY_MS;
let stopped = false;

const send = (op: number, d: unknown) => socket?.send(JSON.stringify({ op, d }));

function stopBeating(): void {
  clearInterval(heartbeat);
  clearTimeout(firstBeat);
}

function beat(): void {
  // Pas de réponse au battement précédent : connexion morte, on repart.
  if (!acknowledged) {
    socket?.terminate();
    return;
  }
  acknowledged = false;
  send(Op.Heartbeat, sequence);
}

function dispatch(type: string | null, data: unknown): void {
  const guard = (task: Promise<void>, label: string) => void task.catch((error) => console.warn(`[discord] ${label}`, (error as Error).message));
  if (type === 'READY') {
    const ready = data as { session_id: string; resume_gateway_url: string; user: { id: string } };
    sessionId = ready.session_id;
    botId = ready.user.id;
    resumeUrl = ready.resume_gateway_url;
    retryMs = MIN_RETRY_MS;
    guard(syncMembers(), 'rattrapage des membres');
    guard(checkAuditAccess(), 'droit du journal de modération');
  } else if (type === 'RESUMED') {
    retryMs = MIN_RETRY_MS;
  } else if (type === 'GUILD_MEMBER_ADD' && (data as { guild_id?: string }).guild_id === config.discord.guildId) {
    guard(onMemberAdd(data as MemberEvent), 'bienvenue');
  } else if (type === 'GUILD_MEMBER_REMOVE' && (data as { guild_id?: string }).guild_id === config.discord.guildId) {
    guard(onMemberRemove((data as MemberEvent).user), 'départ');
  } else if (type === 'GUILD_AUDIT_LOG_ENTRY_CREATE' && (data as AuditEntry).guild_id === config.discord.guildId) {
    onAuditEntry(data as AuditEntry, botId);
  }
}

function onPayload(raw: RawData): void {
  const { op, d, s, t } = JSON.parse(raw.toString()) as Payload;
  if (s !== null) sequence = s;
  if (op === Op.Dispatch) {
    dispatch(t, d);
  } else if (op === Op.Hello) {
    const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
    acknowledged = true;
    stopBeating();
    firstBeat = setTimeout(beat, interval * Math.random());
    heartbeat = setInterval(beat, interval);
    if (sessionId) {
      send(Op.Resume, { token: config.discord.botToken, session_id: sessionId, seq: sequence });
    } else {
      send(Op.Identify, { token: config.discord.botToken, intents: INTENTS, properties: { os: 'linux', browser: 'sixsence', device: 'sixsence' } });
    }
  } else if (op === Op.HeartbeatAck) {
    acknowledged = true;
  } else if (op === Op.Heartbeat) {
    send(Op.Heartbeat, sequence);
  } else if (op === Op.Reconnect) {
    socket?.close(4000);
  } else if (op === Op.InvalidSession) {
    // Session perdue : on repart de zéro, le rattrapage couvre le trou.
    if (!d) {
      sessionId = null;
      resumeUrl = null;
      sequence = null;
    }
    socket?.close(4000);
  }
}

function connect(): void {
  const current = new WebSocket(resumeUrl && sessionId ? `${resumeUrl}/?v=10&encoding=json` : GATEWAY);
  socket = current;
  current.on('message', (raw) => {
    try {
      onPayload(raw);
    } catch (error) {
      console.warn('[discord] message illisible', (error as Error).message);
    }
  });
  current.on('error', (error) => console.warn('[discord] connexion', error.message));
  current.on('close', (code) => {
    if (socket !== current) return;
    stopBeating();
    socket = null;
    if (stopped) return;
    if (FATAL.has(code)) {
      logToDiscord(`🚨 Connexion du bot refusée par Discord (code ${code}) : arrivées et départs à l’arrêt. Vérifie « Server Members Intent » dans le portail développeur.`);
      return;
    }
    retry = setTimeout(connect, retryMs);
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
  });
}

export function startDiscordGateway(): void {
  stopped = false;
  connect();
}

export function stopDiscordGateway(): void {
  stopped = true;
  clearTimeout(retry);
  stopBeating();
  socket?.close(1000);
}
