/**
 * Tournoi de fin de saison (Division, étape 3) : règles pures, testées dans
 * tournamentPolicy.test.ts.
 *
 *   - 8, 16 ou 32 places ; qualifiés : les meilleures équipes du classement avec 25 matchs ou plus ;
 *   - tableau à élimination directe placé selon le classement (1 contre 16, 8 contre 9…) ; places
 *     vides : la tête de série passe directement au tour suivant ;
 *   - BO3, finale en BO5 ; check-in 30 min avant le début, équipe absente au début = forfait.
 */

export const TOURNAMENT_SIZES = [8, 16, 32] as const;
export const QUALIFY_MATCHES = 25;
export const CHECKIN_MINUTES = 30;

export const roundsFor = (size: number) => Math.log2(size);

/** Ordre des têtes de série dans le tableau (8 : 1, 8, 4, 5, 2, 7, 3, 6) : 1 et 2 ne se croisent qu'en finale. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const total = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, total - seed]);
  }
  return order;
}

/** Nom d'un tour (« Finale », « Demi-finales »…). */
export function roundName(round: number, rounds: number): string {
  const left = rounds - round;
  return ['Finale', 'Demi-finales', 'Quarts de finale', 'Huitièmes de finale', 'Seizièmes de finale'][left] ?? `Tour ${round}`;
}

export const bestOfFor = (round: number, rounds: number) => (round === rounds ? 5 : 3);

export interface QualifierInput {
  id: string;
  points: number;
  wins: number;
  played: number;
  createdAt: string;
}

/** Équipes qualifiées, dans l'ordre des têtes de série. */
export function qualifiedTeams<T extends QualifierInput>(teams: T[], size: number, minMatches = QUALIFY_MATCHES): T[] {
  return teams
    .filter((team) => team.played >= minMatches)
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.createdAt.localeCompare(b.createdAt))
    .slice(0, size);
}

export type EntryStatus = 'pending' | 'playing' | 'done' | 'empty' | 'blocked';

export interface BracketEntry {
  round: number;
  slot: number;
  teamA: string | null;
  teamB: string | null;
  winner: string | null;
  status: EntryStatus;
}

/** 1er tour : têtes de série face à face selon seedOrder (null = place vide). */
export function firstRound(seeds: string[], size: number): BracketEntry[] {
  const order = seedOrder(size);
  const entries: BracketEntry[] = [];
  for (let slot = 0; slot < size / 2; slot += 1) {
    entries.push({ round: 1, slot, teamA: seeds[order[slot * 2]! - 1] ?? null, teamB: seeds[order[slot * 2 + 1]! - 1] ?? null, winner: null, status: 'pending' });
  }
  return entries;
}

/** Tours suivants, vides au départ. */
export function emptyRounds(size: number): BracketEntry[] {
  const entries: BracketEntry[] = [];
  for (let round = 2; round <= roundsFor(size); round += 1) {
    for (let slot = 0; slot < size / 2 ** round; slot += 1) entries.push({ round, slot, teamA: null, teamB: null, winner: null, status: 'pending' });
  }
  return entries;
}

/**
 * Fait avancer le tableau : vainqueurs reportés au tour suivant, places vides et forfaits résolus
 * (adversaire absent = qualifié d'office). Renvoie une copie ; les rencontres « pending » avec deux
 * équipes sont prêtes à être jouées.
 */
export function advanceBracket(entries: BracketEntry[], rounds: number): BracketEntry[] {
  const next = entries.map((entry) => ({ ...entry }));
  const at = (round: number, slot: number) => next.find((entry) => entry.round === round && entry.slot === slot);
  const settled = (entry: BracketEntry | undefined) => entry?.status === 'done' || entry?.status === 'empty';
  for (let round = 1; round <= rounds; round += 1) {
    for (const entry of next.filter((e) => e.round === round).sort((a, b) => a.slot - b.slot)) {
      let known = true;
      if (round > 1) {
        const feedA = at(round - 1, entry.slot * 2);
        const feedB = at(round - 1, entry.slot * 2 + 1);
        if (settled(feedA) && !entry.teamA) entry.teamA = feedA!.winner;
        if (settled(feedB) && !entry.teamB) entry.teamB = feedB!.winner;
        known = settled(feedA) && settled(feedB);
      }
      if (!known || entry.status !== 'pending') continue;
      if (!entry.teamA && !entry.teamB) entry.status = 'empty';
      else if (!entry.teamA || !entry.teamB) {
        entry.winner = entry.teamA ?? entry.teamB;
        entry.status = 'done';
      }
    }
  }
  return next;
}

/** Rencontres prêtes à être créées (deux équipes connues, pas encore jouées). */
export const readyEntries = (entries: BracketEntry[]) => entries.filter((entry) => entry.status === 'pending' && entry.teamA && entry.teamB);

/** Vainqueur et finaliste une fois la finale jouée, sinon null. */
export function podium(entries: BracketEntry[], rounds: number): { winner: string | null; finalist: string | null } | null {
  const final = entries.find((entry) => entry.round === rounds);
  if (!final || (final.status !== 'done' && final.status !== 'empty')) return null;
  return { winner: final.winner, finalist: final.winner === final.teamA ? final.teamB : final.teamA };
}
