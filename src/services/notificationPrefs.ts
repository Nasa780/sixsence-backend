import { HttpError, fromDbError } from '../errors.js';
import { supabase } from '../supabase.js';

/**
 * Préférences de notification (migration 0059, table privée notification_prefs) : chaque joueur coupe des
 * catégories en notification (push) et en message privé Discord (dm). Un envoi sans catégorie part toujours
 * (sanctions, modération, retrait d'une équipe, messages de l'équipe SixSence).
 */
export const NOTIFICATION_CATEGORIES = ['match_trouve', 'match', 'file', 'equipe', 'coupes', 'cartes', 'gta'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type NotificationChannel = 'push' | 'dm';

interface PrefsRow {
  user_id: string;
  push_off: string[];
  dm_off: string[];
}

const isCategory = (value: unknown): value is NotificationCategory => NOTIFICATION_CATEGORIES.includes(value as NotificationCategory);

/** Joueurs qui reçoivent encore cette catégorie sur ce canal. */
export async function recipientsFor(userIds: string[], category: NotificationCategory | undefined, channel: NotificationChannel): Promise<string[]> {
  if (!category || userIds.length === 0) return userIds;
  const { data, error } = await supabase.from('notification_prefs').select('user_id, push_off, dm_off').in('user_id', userIds);
  // Préférences illisibles : on envoie quand même (une notification de trop vaut mieux qu'un match manqué).
  if (error) return userIds;
  const off = new Set(((data ?? []) as PrefsRow[]).filter((row) => (channel === 'push' ? row.push_off : row.dm_off).includes(category)).map((row) => row.user_id));
  return userIds.filter((id) => !off.has(id));
}

/** Préférences du joueur : { push: { match: true, … }, dm: { … } } (true = reçu). */
export async function getPrefs(userId: string) {
  const { data, error } = await supabase.from('notification_prefs').select('user_id, push_off, dm_off').eq('user_id', userId).maybeSingle();
  if (error) throw fromDbError(error);
  const row = data as PrefsRow | null;
  const view = (off: string[] = []) => Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, !off.includes(category)]));
  return { push: view(row?.push_off), dm: view(row?.dm_off) };
}

/** Enregistre { push?: { catégorie: booléen }, dm?: { … } } (catégories absentes : inchangées). */
export async function setPrefs(userId: string, body: unknown) {
  const input = (body ?? {}) as { push?: Record<string, unknown>; dm?: Record<string, unknown> };
  const current = await getPrefs(userId);
  const merge = (now: Record<string, boolean>, next: Record<string, unknown> | undefined) => {
    if (next !== undefined && (typeof next !== 'object' || next === null)) throw new HttpError(400, 'INVALID_PREFS', 'Préférences invalides.');
    const merged = { ...now };
    for (const [key, value] of Object.entries(next ?? {})) {
      if (!isCategory(key) || typeof value !== 'boolean') throw new HttpError(400, 'INVALID_PREFS', 'Préférences invalides.');
      merged[key] = value;
    }
    return NOTIFICATION_CATEGORIES.filter((category) => !merged[category]);
  };
  const { error } = await supabase
    .from('notification_prefs')
    .upsert({ user_id: userId, push_off: merge(current.push, input.push), dm_off: merge(current.dm, input.dm), updated_at: new Date().toISOString() });
  if (error) throw fromDbError(error);
  return getPrefs(userId);
}
