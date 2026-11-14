import { config } from '../config.js';
import { HttpError, fromDbError } from '../errors.js';
import { supabase } from '../supabase.js';
import { dm, notifyStaff } from './discord.js';
import { REPORT_REASONS, reportPlayer } from './moderation.js';
import { normalizeName, rankPlayers } from './playerSearch.js';
import { pushToUsers } from './push.js';

/**
 * Messagerie entre joueurs (migration 0074, étape 1) : conversations à deux, messages de 1 000 caractères au plus,
 * gardés 30 jours. Chaque nouveau message arrive dans la cloche et en notification push ; le message privé Discord
 * ne part que pour le premier message non lu d'une conversation (pas d'avalanche). Catégorie « messages » coupable.
 * Personne ne lit les conversations des autres (l'équipe seulement sur signalement, étape 2).
 */

export const MESSAGE_MAX = 1000;
const PAGE = 50;
const LIST_LIMIT = 50;
const KEEP_DAYS = 30;
const PER_MINUTE = 20;
const NEW_PER_DAY = 10;
const PREVIEW = 120;

interface UserCard {
  id: string;
  username: string;
  avatar_url: string | null;
}

interface ConversationRow {
  id: string;
  user_a: string;
  user_b: string;
  last_message_at: string;
  last_sender: string | null;
  last_body: string | null;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

const pair = (a: string, b: string) => (a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a });
const preview = (body: string) => (body.length > PREVIEW ? `${body.slice(0, PREVIEW - 1)}…` : body);
const card = (user: UserCard | undefined, id: string) => ({ id, username: user?.username ?? 'Joueur', avatarUrl: user?.avatar_url ?? null });
const message = (row: MessageRow) => ({ id: row.id, senderId: row.sender_id, body: row.body, createdAt: row.created_at, read: Boolean(row.read_at) });

async function usersById(ids: string[]): Promise<Map<string, UserCard>> {
  if (ids.length === 0) return new Map();
  const { data } = await supabase.from('users').select('id, username, avatar_url').in('id', ids);
  return new Map(((data ?? []) as UserCard[]).map((user) => [user.id, user]));
}

/** Exclusion définitive (banned_until en 9999) : plus de messages. Une exclusion de la file n'empêche pas d'écrire. */
async function isBanned(userId: string): Promise<boolean> {
  const { data } = await supabase.from('cod_profiles').select('banned_until').eq('user_id', userId).maybeSingle();
  const until = (data as { banned_until: string | null } | null)?.banned_until;
  return Boolean(until && new Date(until).getUTCFullYear() >= 9999);
}

async function findConversation(me: string, other: string): Promise<ConversationRow | null> {
  const { data, error } = await supabase.from('dm_conversations').select('id, user_a, user_b, last_message_at, last_sender, last_body').match(pair(me, other)).maybeSingle();
  if (error) throw fromDbError(error);
  return data as ConversationRow | null;
}

/** Conversations du joueur, la plus récente d'abord, avec l'autre joueur, le dernier message et les non lus (GET /messages). */
export async function conversations(me: string) {
  const [{ data, error }, { data: unread }] = await Promise.all([
    supabase.from('dm_conversations').select('id, user_a, user_b, last_message_at, last_sender, last_body').or(`user_a.eq.${me},user_b.eq.${me}`).order('last_message_at', { ascending: false }).limit(LIST_LIMIT),
    supabase.from('dm_messages').select('conversation_id').eq('recipient_id', me).is('read_at', null).limit(1000),
  ]);
  if (error) throw fromDbError(error);
  const rows = (data ?? []) as ConversationRow[];
  const counts = new Map<string, number>();
  for (const row of (unread ?? []) as { conversation_id: string }[]) counts.set(row.conversation_id, (counts.get(row.conversation_id) ?? 0) + 1);
  const otherOf = (row: ConversationRow) => (row.user_a === me ? row.user_b : row.user_a);
  const users = await usersById(rows.map(otherOf));
  const items = rows.map((row) => ({
    id: row.id,
    with: card(users.get(otherOf(row)), otherOf(row)),
    lastMessageAt: row.last_message_at,
    lastBody: row.last_body,
    lastFromMe: row.last_sender === me,
    unread: counts.get(row.id) ?? 0,
  }));
  return { conversations: items, unread: [...counts.values()].reduce((sum, count) => sum + count, 0) };
}

/** Nombre de messages non lus (enveloppe de la barre du haut, GET /messages/unread). */
export async function unreadCount(me: string): Promise<{ unread: number }> {
  const { count } = await supabase.from('dm_messages').select('id', { count: 'exact', head: true }).eq('recipient_id', me).is('read_at', null);
  return { unread: count ?? 0 };
}

/**
 * Conversation avec un joueur (GET /messages/:userId) : l'autre joueur et 50 messages, du plus ancien au plus récent,
 * avant `before` (id) pour remonter. Les messages reçus sont marqués lus.
 */
export async function conversationWith(me: string, other: string, before: number | null) {
  if (me === other) throw new HttpError(400, 'SELF_MESSAGE', 'Tu ne peux pas t’écrire à toi-même.');
  const users = await usersById([other]);
  if (!users.has(other)) throw new HttpError(404, 'PLAYER_NOT_FOUND', 'Joueur introuvable.');
  const [conversation, state] = await Promise.all([findConversation(me, other), writeState(me, other)]);
  if (!conversation) return { with: card(users.get(other), other), messages: [], hasMore: false, ...state };
  let query = supabase.from('dm_messages').select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at').eq('conversation_id', conversation.id).order('id', { ascending: false }).limit(PAGE + 1);
  if (before) query = query.lt('id', before);
  const { data, error } = await query;
  if (error) throw fromDbError(error);
  const rows = (data ?? []) as MessageRow[];
  const hasMore = rows.length > PAGE;
  if (!before) await markRead(me, other);
  return { with: card(users.get(other), other), messages: rows.slice(0, PAGE).reverse().map(message), hasMore, ...state };
}

// --- Protection (étape 2, migration 0075) -------------------------------------------

/** Blocages entre deux joueurs, dans les deux sens. */
async function blocksBetween(me: string, other: string): Promise<{ byMe: boolean; byOther: boolean }> {
  const { data } = await supabase
    .from('dm_blocks')
    .select('blocker_id')
    .or(`and(blocker_id.eq.${me},blocked_id.eq.${other}),and(blocker_id.eq.${other},blocked_id.eq.${me})`);
  const blockers = new Set(((data ?? []) as { blocker_id: string }[]).map((row) => row.blocker_id));
  return { byMe: blockers.has(me), byOther: blockers.has(other) };
}

/** Le destinataire accepte-t-il les messages de ce joueur (réglage « qui peut m'écrire ») ? */
async function accepts(recipient: string, sender: string): Promise<boolean> {
  const { data } = await supabase.from('dm_prefs').select('allow').eq('user_id', recipient).maybeSingle();
  const allow = (data as { allow: string } | null)?.allow ?? 'all';
  if (allow === 'all') return true;
  if (allow === 'none') return false;
  const { data: members } = await supabase.from('team_members').select('user_id, team_id').in('user_id', [recipient, sender]);
  const teams = new Map(((members ?? []) as { user_id: string; team_id: string }[]).map((row) => [row.user_id, row.team_id]));
  return Boolean(teams.get(recipient) && teams.get(recipient) === teams.get(sender));
}

/**
 * Peut-on écrire à ce joueur ? blockedByMe : je l'ai bloqué (je peux le débloquer). Sinon, un blocage de sa part
 * ou son réglage donne seulement canWrite à false, sans dire pourquoi (on ne révèle pas qu'on est bloqué).
 */
async function writeState(me: string, other: string): Promise<{ canWrite: boolean; blockedByMe: boolean }> {
  const blocks = await blocksBetween(me, other);
  if (blocks.byMe) return { canWrite: false, blockedByMe: true };
  if (blocks.byOther) return { canWrite: false, blockedByMe: false };
  return { canWrite: await accepts(other, me), blockedByMe: false };
}

const ALLOW_VALUES = ['all', 'team', 'none'] as const;

/** Réglages de la messagerie (GET /messages/settings) : qui peut m'écrire, joueurs bloqués. */
export async function messageSettings(me: string) {
  const [{ data: prefs }, { data: blocks }] = await Promise.all([
    supabase.from('dm_prefs').select('allow').eq('user_id', me).maybeSingle(),
    supabase.from('dm_blocks').select('blocked_id, created_at').eq('blocker_id', me).order('created_at', { ascending: false }),
  ]);
  const ids = ((blocks ?? []) as { blocked_id: string }[]).map((row) => row.blocked_id);
  const users = await usersById(ids);
  return { allow: (prefs as { allow: string } | null)?.allow ?? 'all', blocked: ids.map((id) => card(users.get(id), id)) };
}

/** Change « qui peut m'écrire » (POST /messages/settings { allow: all | team | none }). */
export async function setMessageSettings(me: string, input: unknown) {
  const allow = (input as { allow?: unknown } | undefined)?.allow;
  if (!ALLOW_VALUES.includes(allow as (typeof ALLOW_VALUES)[number])) throw new HttpError(400, 'INVALID_SETTING', 'Choix invalide.');
  const { error } = await supabase.from('dm_prefs').upsert({ user_id: me, allow, updated_at: new Date().toISOString() });
  if (error) throw fromDbError(error);
  return messageSettings(me);
}

/** Bloque un joueur (POST /messages/:userId/block) : plus aucun message entre vous, dans les deux sens. */
export async function blockPlayer(me: string, other: string) {
  if (me === other) throw new HttpError(400, 'SELF_BLOCK', 'Tu ne peux pas te bloquer toi-même.');
  const users = await usersById([other]);
  if (!users.has(other)) throw new HttpError(404, 'PLAYER_NOT_FOUND', 'Joueur introuvable.');
  const { error } = await supabase.from('dm_blocks').upsert({ blocker_id: me, blocked_id: other }, { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true });
  if (error) throw fromDbError(error);
  return writeState(me, other);
}

/** Débloque un joueur (DELETE /messages/:userId/block). */
export async function unblockPlayer(me: string, other: string) {
  await supabase.from('dm_blocks').delete().eq('blocker_id', me).eq('blocked_id', other);
  return writeState(me, other);
}

const SNAPSHOT_MESSAGES = 50;
export const DM_REPORT_REASONS = ['toxicity', 'spam', 'name', 'other'] as const;

/**
 * Signale une conversation (POST /messages/:userId/report { reason, details }) : signalement de joueur classique
 * (mêmes limites), avec une copie des 50 derniers messages, seule partie de la conversation que l'équipe verra.
 */
export async function reportConversation(me: string, other: string, input: unknown) {
  const body = (input ?? {}) as { reason?: unknown; details?: unknown };
  if (!DM_REPORT_REASONS.includes(body.reason as (typeof DM_REPORT_REASONS)[number])) throw new HttpError(400, 'INVALID_REASON', 'Choisis un motif.');
  const conversation = await findConversation(me, other);
  if (!conversation) throw new HttpError(404, 'NO_CONVERSATION', 'Aucune conversation avec ce joueur.');
  const report = await reportPlayer(me, { targetId: other, reason: body.reason, details: body.details });
  const { data } = await supabase.from('dm_messages').select('sender_id, body, created_at').eq('conversation_id', conversation.id).order('id', { ascending: false }).limit(SNAPSHOT_MESSAGES);
  const rows = ((data ?? []) as { sender_id: string; body: string; created_at: string }[]).reverse();
  const users = await usersById([me, other]);
  const snapshot = rows.map((row) => ({ from: users.get(row.sender_id)?.username ?? 'Joueur', fromReporter: row.sender_id === me, body: row.body, at: row.created_at }));
  await supabase.from('cod_player_reports').update({ conversation_id: conversation.id, dm_snapshot: snapshot }).eq('id', report.id);
  void notifyStaff(
    `🚩 **Signalement de messages privés** — ${REPORT_REASONS[report.reason]} : ${users.get(other)?.username ?? 'Joueur'}\n` +
      `Par ${users.get(me)?.username ?? 'Joueur'}${report.details ? ` : « ${report.details} »` : ''} · ${snapshot.length} message(s) joint(s)\n` +
      `${config.siteUrl}/admin?onglet=signalements`,
  );
  return { reported: true };
}

/** Marque lus les messages reçus de ce joueur (POST /messages/:userId/read). */
export async function markRead(me: string, other: string): Promise<{ unread: number }> {
  const conversation = await findConversation(me, other);
  if (conversation) {
    await supabase.from('dm_messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', conversation.id).eq('recipient_id', me).is('read_at', null);
  }
  return unreadCount(me);
}

/** Envoie un message (POST /messages/:userId { body }) ; crée la conversation au premier message. */
export async function sendMessage(me: string, other: string, input: unknown) {
  const body = typeof (input as { body?: unknown } | undefined)?.body === 'string' ? ((input as { body: string }).body).trim() : '';
  if (!body) throw new HttpError(400, 'EMPTY_MESSAGE', 'Écris un message avant d’envoyer.');
  if (body.length > MESSAGE_MAX) throw new HttpError(400, 'MESSAGE_TOO_LONG', `${MESSAGE_MAX} caractères au plus.`);
  if (me === other) throw new HttpError(400, 'SELF_MESSAGE', 'Tu ne peux pas t’écrire à toi-même.');
  const users = await usersById([me, other]);
  if (!users.has(other)) throw new HttpError(404, 'PLAYER_NOT_FOUND', 'Joueur introuvable.');
  if (await isBanned(me)) throw new HttpError(403, 'BANNED', 'Ton compte est exclu : tu ne peux plus envoyer de messages.');
  const state = await writeState(me, other);
  if (state.blockedByMe) throw new HttpError(403, 'BLOCKED_BY_YOU', 'Tu as bloqué ce joueur : débloque-le pour lui écrire.');
  if (!state.canWrite) throw new HttpError(403, 'RECIPIENT_UNAVAILABLE', 'Ce joueur ne reçoit pas tes messages.');

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await supabase.from('dm_messages').select('id', { count: 'exact', head: true }).eq('sender_id', me).gte('created_at', since);
  if ((recent ?? 0) >= PER_MINUTE) throw new HttpError(429, 'TOO_MANY_MESSAGES', 'Trop de messages d’un coup : attends une minute.');

  let conversation = await findConversation(me, other);
  if (!conversation) {
    const day = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { count: started } = await supabase.from('dm_conversations').select('id', { count: 'exact', head: true }).eq('created_by', me).gte('created_at', day);
    if ((started ?? 0) >= NEW_PER_DAY) throw new HttpError(429, 'TOO_MANY_CONVERSATIONS', `${NEW_PER_DAY} nouvelles conversations par jour au plus : réessaie demain, ou réponds à tes conversations en cours.`);
    const { data, error } = await supabase
      .from('dm_conversations')
      .upsert({ ...pair(me, other), created_by: me }, { onConflict: 'user_a,user_b' })
      .select('id, user_a, user_b, last_message_at, last_sender, last_body')
      .single();
    if (error) throw fromDbError(error);
    conversation = data as ConversationRow;
  }

  // Message Discord seulement si l'autre joueur n'avait rien de non lu dans cette conversation.
  const { count: alreadyUnread } = await supabase.from('dm_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', conversation.id).eq('recipient_id', other).is('read_at', null);

  const { data, error } = await supabase
    .from('dm_messages')
    .insert({ conversation_id: conversation.id, sender_id: me, recipient_id: other, body })
    .select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at')
    .single();
  if (error) throw fromDbError(error);
  const row = data as MessageRow;
  await supabase.from('dm_conversations').update({ last_message_at: row.created_at, last_sender: me, last_body: preview(body) }).eq('id', conversation.id);

  const name = users.get(me)?.username ?? 'Un joueur';
  const path = `/messages?avec=${me}`;
  void pushToUsers([other], { title: `Message de ${name}`, body: preview(body), url: path, tag: `dm-${conversation.id}`, category: 'messages' }).catch(() => {});
  if (!alreadyUnread) {
    void dm([other], `💬 **${name}** t’a envoyé un message sur SixSence :\n> ${preview(body).replace(/\n/g, '\n> ')}\nRépondre : ${config.siteUrl}${path}`, 'messages').catch(() => {});
  }
  return { message: message(row), conversationId: conversation.id };
}

/** Joueurs à qui écrire, par pseudo (GET /messages/search?q=, 2 caractères au moins, 10 résultats). */
export async function searchPlayers(me: string, query: unknown) {
  const text = typeof query === 'string' ? query.trim().slice(0, 40) : '';
  if (text.length < 2) return { players: [] };
  const players = await playerIndex();
  // Même recherche que l'admin : pseudos stylisés ramenés à des lettres simples (« noxira » trouve « 𝑵ø𝒙𝒊ř𝒂 »),
  // identifiant Activision compris. Une recherche faite seulement de symboles compare le pseudo tel quel.
  const found = normalizeName(text)
    ? rankPlayers(players, text)
    : players.filter((player) => player.username.toLowerCase().includes(text.toLowerCase()));
  return { players: found.filter((player) => player.id !== me).slice(0, 10).map((player) => card({ id: player.id, username: player.username, avatar_url: player.avatarUrl }, player.id)) };
}

interface IndexedPlayer {
  id: string;
  username: string;
  avatarUrl: string | null;
  activisionId: string | null;
  points: number;
}

let indexCache: { at: number; players: IndexedPlayer[] } | null = null;

/** Joueurs inscrits (pseudo, avatar, identifiant Activision, points), gardés une minute en mémoire. */
async function playerIndex(): Promise<IndexedPlayer[]> {
  if (indexCache && Date.now() - indexCache.at < 60_000) return indexCache.players;
  const [{ data: users, error }, { data: profiles }] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').limit(10000),
    supabase.from('cod_profiles').select('user_id, activision_id, points').limit(10000),
  ]);
  if (error) throw fromDbError(error);
  const byUser = new Map(((profiles ?? []) as { user_id: string; activision_id: string | null; points: number }[]).map((row) => [row.user_id, row]));
  const players = ((users ?? []) as UserCard[]).map((user) => ({
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar_url,
    activisionId: byUser.get(user.id)?.activision_id ?? null,
    points: byUser.get(user.id)?.points ?? 0,
  }));
  indexCache = { at: Date.now(), players };
  return players;
}

/** Ménage : messages de plus de 30 jours supprimés, conversations vides ensuite. */
export async function purgeOldMessages(): Promise<void> {
  const before = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60_000).toISOString();
  const { error } = await supabase.from('dm_messages').delete().lt('created_at', before);
  if (error) return void console.warn('[messages] ménage impossible', error.message);
  await supabase.from('dm_conversations').delete().lt('last_message_at', before);
  // Copies de conversations jointes aux signalements : effacées 30 jours après leur traitement.
  await supabase.from('cod_player_reports').update({ dm_snapshot: null }).not('dm_snapshot', 'is', null).neq('status', 'open').lt('resolved_at', before);
}
