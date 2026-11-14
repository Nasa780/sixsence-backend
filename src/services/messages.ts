import { config } from '../config.js';
import { HttpError, fromDbError } from '../errors.js';
import { supabase } from '../supabase.js';
import { dm } from './discord.js';
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
  const conversation = await findConversation(me, other);
  if (!conversation) return { with: card(users.get(other), other), messages: [], hasMore: false };
  let query = supabase.from('dm_messages').select('id, conversation_id, sender_id, recipient_id, body, created_at, read_at').eq('conversation_id', conversation.id).order('id', { ascending: false }).limit(PAGE + 1);
  if (before) query = query.lt('id', before);
  const { data, error } = await query;
  if (error) throw fromDbError(error);
  const rows = (data ?? []) as MessageRow[];
  const hasMore = rows.length > PAGE;
  if (!before) await markRead(me, other);
  return { with: card(users.get(other), other), messages: rows.slice(0, PAGE).reverse().map(message), hasMore };
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

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recent } = await supabase.from('dm_messages').select('id', { count: 'exact', head: true }).eq('sender_id', me).gte('created_at', since);
  if ((recent ?? 0) >= PER_MINUTE) throw new HttpError(429, 'TOO_MANY_MESSAGES', 'Trop de messages d’un coup : attends une minute.');

  let conversation = await findConversation(me, other);
  if (!conversation) {
    const { data, error } = await supabase.from('dm_conversations').upsert(pair(me, other), { onConflict: 'user_a,user_b' }).select('id, user_a, user_b, last_message_at, last_sender, last_body').single();
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
  const pattern = `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const { data, error } = await supabase.from('users').select('id, username, avatar_url').ilike('username', pattern).neq('id', me).order('username').limit(10);
  if (error) throw fromDbError(error);
  return { players: ((data ?? []) as UserCard[]).map((user) => card(user, user.id)) };
}

/** Ménage : messages de plus de 30 jours supprimés, conversations vides ensuite. */
export async function purgeOldMessages(): Promise<void> {
  const before = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60_000).toISOString();
  const { error } = await supabase.from('dm_messages').delete().lt('created_at', before);
  if (error) return void console.warn('[messages] ménage impossible', error.message);
  await supabase.from('dm_conversations').delete().lt('last_message_at', before);
}
