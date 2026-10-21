/**
 * Présence sur le site : chaque onglet ouvert sur SixSence se signale toutes les 45 s (POST /presence)
 * avec un identifiant de visiteur aléatoire (gardé dans son navigateur). Un visiteur est « en ligne »
 * s'il s'est signalé dans les 90 dernières secondes. En mémoire (une seule instance Render) ; aucune
 * donnée personnelle : seul l'identifiant aléatoire et l'heure du dernier signal sont gardés.
 */

const WINDOW_MS = 90_000;
const MAX_VISITORS = 20_000;
const seen = new Map<string, number>();

/** Identifiant accepté : 8 à 64 caractères simples (UUID du navigateur en pratique). */
export function isVisitorId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value);
}

export function markPresent(visitorId: string, now = Date.now()): void {
  if (!seen.has(visitorId) && seen.size >= MAX_VISITORS) prune(now);
  if (!seen.has(visitorId) && seen.size >= MAX_VISITORS) return;
  seen.set(visitorId, now);
}

/** Nombre de visiteurs vus dans les 90 dernières secondes. */
export function onlineVisitors(now = Date.now()): number {
  prune(now);
  return seen.size;
}

function prune(now: number): void {
  for (const [id, at] of seen) if (now - at > WINDOW_MS) seen.delete(id);
}
