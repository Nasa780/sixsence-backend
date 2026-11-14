import { supabase } from '../supabase.js';

/**
 * Centre de notifications (cloche du site, migration 0073) : chaque notification envoyée par pushToUsers
 * y est copiée pour chaque joueur, même sans notification push activée ni préférence. Table privée.
 */

const INBOX_LIMIT = 30;
const KEEP_DAYS = 30;

export interface InboxMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
  category?: string;
}

/** Copie une notification dans le centre de chaque joueur ; une de même tag remplace la précédente. */
export async function recordNotifications(userIds: string[], message: InboxMessage): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  try {
    if (message.tag) await supabase.from('notifications').delete().in('user_id', ids).eq('tag', message.tag);
    const rows = ids.map((userId) => ({
      user_id: userId,
      category: message.category ?? null,
      title: message.title.slice(0, 200),
      body: message.body.slice(0, 500),
      url: message.url,
      tag: message.tag ?? null,
    }));
    const { error } = await supabase.from('notifications').insert(rows);
    if (error) console.warn('[notifications] enregistrement impossible', error.message);
  } catch (error) {
    console.warn('[notifications] enregistrement impossible', (error as Error).message);
  }
}

/** Les 30 dernières notifications du joueur et le nombre de non lues (GET /push/inbox). */
export async function inbox(userId: string) {
  const [{ data }, { count }] = await Promise.all([
    supabase.from('notifications').select('id, category, title, body, url, created_at, read_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(INBOX_LIMIT),
    supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('read_at', null),
  ]);
  const items = ((data ?? []) as { id: number; category: string | null; title: string; body: string; url: string; created_at: string; read_at: string | null }[]).map((row) => ({
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    url: row.url,
    createdAt: row.created_at,
    read: Boolean(row.read_at),
  }));
  return { items, unread: count ?? 0 };
}

/** Marque comme lues les notifications données (ids), ou toutes sans ids (POST /push/inbox/read). */
export async function markRead(userId: string, body: unknown): Promise<{ unread: number }> {
  const raw = (body as { ids?: unknown } | undefined)?.ids;
  const ids = Array.isArray(raw) ? raw.filter((id): id is number => Number.isInteger(id)).slice(0, 100) : null;
  let query = supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', userId).is('read_at', null);
  if (ids) query = query.in('id', ids);
  await query;
  const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('read_at', null);
  return { unread: count ?? 0 };
}

/** Ménage : notifications de plus de 30 jours supprimées. */
export async function purgeOldNotifications(): Promise<void> {
  const before = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60_000).toISOString();
  const { error } = await supabase.from('notifications').delete().lt('created_at', before);
  if (error) console.warn('[notifications] ménage impossible', error.message);
}
