/**
 * Durée maximale de recherche : règles pures (testées dans queuePolicy.test.ts).
 *
 * Chaque groupe en file (un joueur seul est un groupe d'une personne) a un compteur
 * qui part de sa dernière confirmation de présence. Peu avant la fin, on lui demande
 * « Toujours là ? » ; sans réponse, sa recherche s'arrête.
 */

export interface TimedGroup {
  groupId: string;
  /** Dernière confirmation de présence (ms). */
  confirmedAt: number;
  /** Message « Toujours là ? » déjà envoyé (ms), ou null. */
  warnedAt: number | null;
}

export interface TimeoutRules {
  /** Durée maximale sans confirmation. */
  maxMs: number;
  /** Avance du message « Toujours là ? » sur l'arrêt. */
  warnMs: number;
}

/** Groupes à prévenir et groupes dont la recherche s'arrête, à l'instant now. */
export function queueTimeouts(groups: TimedGroup[], now: number, rules: TimeoutRules): { warn: string[]; expire: string[] } {
  const warn: string[] = [];
  const expire: string[] = [];
  for (const group of groups) {
    const waited = now - group.confirmedAt;
    if (waited >= rules.maxMs) expire.push(group.groupId);
    else if (group.warnedAt === null && waited >= rules.maxMs - rules.warnMs) warn.push(group.groupId);
  }
  return { warn, expire };
}

/** Heure d'arrêt de la recherche d'un groupe (ms). */
export function expiresAt(confirmedAt: number, rules: TimeoutRules): number {
  return confirmedAt + rules.maxMs;
}
