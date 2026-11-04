/**
 * Règles anti-spam des annonces de file sur Discord (fonctions pures, testées dans
 * announcePolicy.test.ts).
 */
/** Palier d'une file : 0 = rien à annoncer, 1 = moitié des places prises, 2 = plus qu'une place. */
export function queueLevel(size: number, needed: number): number {
  const half = Math.max(2, Math.ceil(needed / 2));
  if (needed >= 4 && size >= needed - 1 && size < needed) return 2;
  return size >= half && size < needed ? 1 : 0;
}

/**
 * Décide s'il faut annoncer ce palier : seulement en montant de palier, et au moins
 * 10 minutes après la dernière annonce de cette file. Met à jour l'état mémorisé.
 */
export function shouldAnnounce(state: Map<string, { level: number; at: number }>, format: string, level: number, now = Date.now()): boolean {
  const last = state.get(format) ?? { level: 0, at: 0 };
  if (level === 0) {
    if (last.level !== 0) state.set(format, { level: 0, at: last.at });
    return false;
  }
  if (level <= last.level || now - last.at < 10 * 60_000) return false;
  state.set(format, { level, at: now });
  return true;
}

/** Annonces programmées : 20 en attente au plus, de 2 minutes à 60 jours, 6 h de retard toléré. */
export const MAX_PENDING = 20;
const MIN_DELAY_MS = 2 * 60_000;
const MAX_DELAY_MS = 60 * 86_400_000;
const MAX_LATE_MS = 6 * 3_600_000;

/** Date de publication au format ISO, ou null si elle est invalide ou hors limites. */
export function parsePostAt(value: unknown, now: number): string | null {
  if (typeof value !== 'string') return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || time < now + MIN_DELAY_MS || time > now + MAX_DELAY_MS) return null;
  return new Date(time).toISOString();
}

/** Que faire d'une annonce : attendre, publier, ou abandonner si le retard est trop grand. */
export function dueAction(postAt: string, now: number): 'wait' | 'post' | 'too_late' {
  const time = new Date(postAt).getTime();
  if (time > now) return 'wait';
  return now - time > MAX_LATE_MS ? 'too_late' : 'post';
}
