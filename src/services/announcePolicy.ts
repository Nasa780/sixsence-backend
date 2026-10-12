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
