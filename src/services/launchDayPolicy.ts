/**
 * Jour 1 de GTA 6 (2026-11-17) : un joueur connecté au site pendant les 48 h qui suivent la sortie (19 novembre 2026
 * à minuit, heure de Paris, jusqu'au 20 novembre 23 h 59) reçoit le badge `gta6-jour1`, qui débloque la carte de visite
 * exclusive « Jour 1 · Vice City » (src/cards.ts). Plus personne ne peut l'obtenir ensuite.
 */

export const LAUNCH_BADGE = 'gta6-jour1';
export const LAUNCH_START = Date.parse('2026-11-19T00:00:00+01:00');
export const LAUNCH_END = LAUNCH_START + 2 * 86_400_000;

/** Vrai pendant les 48 h du jour 1. */
export function inLaunchDay(now: number): boolean {
  return now >= LAUNCH_START && now < LAUNCH_END;
}

/** Badges du joueur avec celui du jour 1 ajouté, ou null s'il l'a déjà (aucune écriture). */
export function withLaunchBadge(badges: string[] | null | undefined): string[] | null {
  const list = badges ?? [];
  return list.includes(LAUNCH_BADGE) ? null : [...list, LAUNCH_BADGE];
}
