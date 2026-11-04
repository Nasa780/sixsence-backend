import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { MAX_PENDING, dueAction, parsePostAt } from './announcePolicy.js';
import { parseAnnouncement, postAnnouncement, type AnnounceType } from './announcements.js';
import { logToDiscord } from './siteLog.js';

/**
 * Annonces Discord programmées (migration 0062, /admin/discord/scheduled) : l'admin choisit une date, le serveur
 * publie l'annonce à l'heure, avec les mêmes règles qu'une annonce publiée à la main. Vérifié toutes les minutes et
 * au démarrage (serveur en veille : publiée au réveil, jusqu'à 6 h de retard, sinon abandonnée et signalée).
 */
interface Row {
  id: string;
  type: AnnounceType;
  title: string;
  body: string;
  url: string | null;
  post_at: string;
  status: string;
  error: string | null;
  posted_at: string | null;
}

const COLUMNS = 'id, type, title, body, url, post_at, status, error, posted_at';
const shape = (row: Row) => ({ id: row.id, type: row.type, title: row.title, text: row.body, url: row.url, postAt: row.post_at, status: row.status, error: row.error, postedAt: row.posted_at });

/** Annonces à venir, puis les 5 dernières traitées. */
export async function listScheduled() {
  const [upcoming, past] = await Promise.all([
    supabase.from('scheduled_announcements').select(COLUMNS).in('status', ['pending', 'sending']).order('post_at'),
    supabase.from('scheduled_announcements').select(COLUMNS).in('status', ['posted', 'failed']).order('post_at', { ascending: false }).limit(5),
  ]);
  return { upcoming: (unwrap(upcoming) as Row[]).map(shape), past: (unwrap(past) as Row[]).map(shape) };
}

export async function scheduleAnnouncement(userId: string, body: unknown) {
  const item = parseAnnouncement(body);
  const postAt = parsePostAt((body as { postAt?: unknown } | null)?.postAt, Date.now());
  if (!postAt) throw new HttpError(400, 'INVALID_DATE', 'Choisis une date entre dans 2 minutes et dans 60 jours.');
  const { count } = await supabase.from('scheduled_announcements').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  if ((count ?? 0) >= MAX_PENDING) throw new HttpError(409, 'TOO_MANY', `${MAX_PENDING} annonces programmées au plus : annules-en une.`);
  unwrap(await supabase.from('scheduled_announcements').insert({ type: item.type, title: item.title, body: item.text, url: item.url ?? null, post_at: postAt, created_by: userId }).select('id').single());
  return listScheduled();
}

/** Annule une annonce pas encore partie. */
export async function cancelScheduled(id: string) {
  const { data } = await supabase.from('scheduled_announcements').update({ status: 'cancelled' }).eq('id', id).eq('status', 'pending').select('id').maybeSingle();
  if (!data) throw new HttpError(409, 'NOT_PENDING', 'Cette annonce est déjà partie ou annulée.');
  return listScheduled();
}

async function close(id: string, status: 'posted' | 'failed', error: string | null = null): Promise<void> {
  await supabase.from('scheduled_announcements').update({ status, error, posted_at: status === 'posted' ? new Date().toISOString() : null }).eq('id', id);
}

/** Publie ce qui est arrivé à l'heure. Une annonce réservée par « sending » ne peut pas partir deux fois. */
export async function sweepScheduledAnnouncements(now = Date.now()): Promise<void> {
  // Serveur coupé pendant un envoi : on ne sait pas si le message est parti, on ne republie pas.
  const stuck = new Date(now - 10 * 60_000).toISOString();
  await supabase.from('scheduled_announcements').update({ status: 'failed', error: 'Envoi interrompu : vérifie sur Discord si elle est partie.' }).eq('status', 'sending').lt('post_at', stuck);

  const { data } = await supabase.from('scheduled_announcements').select(COLUMNS).eq('status', 'pending').lte('post_at', new Date(now).toISOString()).order('post_at').limit(5);
  for (const row of (data ?? []) as Row[]) {
    const { data: claimed } = await supabase.from('scheduled_announcements').update({ status: 'sending' }).eq('id', row.id).eq('status', 'pending').select('id').maybeSingle();
    if (!claimed) continue;
    if (dueAction(row.post_at, now) === 'too_late') {
      await close(row.id, 'failed', 'Serveur en veille à l’heure prévue : annonce abandonnée.');
      logToDiscord(`⚠️ Annonce programmée non publiée (serveur en veille) : **${row.title}**`);
      continue;
    }
    try {
      await postAnnouncement({ type: row.type, title: row.title, text: row.body, url: row.url ?? undefined }, true);
      await close(row.id, 'posted');
    } catch (caught) {
      const message = (caught as Error).message;
      await close(row.id, 'failed', message.slice(0, 300));
      logToDiscord(`⚠️ Annonce programmée non publiée : **${row.title}** (${message})`);
    }
  }
}
