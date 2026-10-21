/**
 * Tournoi de fin de saison (Division, étape 3) : règles pures, testées dans
 * tournamentPolicy.test.ts.
 *
 *   - 8, 16 ou 32 places ; qualifiés : les meilleures équipes du classement avec 25 matchs ou plus ;
 *   - tableau à élimination directe placé selon le classement (1 contre 16, 8 contre 9…) ; places
 *     vides : la tête de série passe directement au tour suivant ;
 *   - BO3, finale en BO5 ; check-in 30 min avant le début, équipe absente au début = forfait.
 *
 * Coupe Horus (inscription libre) : 4, 8 ou 16 places, matchs en BO1 ou BO3, finale en BO3 ou BO5,
 * petite finale entre les perdants des demies (bronze), tableau tiré au sort.
 */

export const TOURNAMENT_SIZES = [8, 16, 32] as const;
export const CUP_SIZES = [4, 8, 16] as const;
/** Une coupe se joue à partir de 4 équipes présentes au check-in. */
export const CUP_MIN_TEAMS = 4;
/** Points de Division gagnés en Coupe Horus. */
export const CUP_BONUS = { or: 150, argent: 100, bronze: 75, participation: 50 } as const;
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

export interface MatchFormat {
  bestOf: number;
  finalBestOf: number;
}
export const SEASON_FORMAT: MatchFormat = { bestOf: 3, finalBestOf: 5 };

/** Format d'une rencontre : la finale (dernier tour, slot 0) a le sien, la petite finale suit les autres matchs. */
export const bestOfFor = (round: number, rounds: number, format: MatchFormat = SEASON_FORMAT, slot = 0) =>
  round === rounds && slot === 0 ? format.finalBestOf : format.bestOf;

/** Petite finale : dernier tour, slot 1. */
export const isThirdPlace = (entry: { round: number; slot: number }, rounds: number) => entry.round === rounds && entry.slot === 1;

/** Plus petit tableau (puissance de 2) pour `count` équipes, entre 4 et `max`. */
export function bracketSizeFor(count: number, max: number): number {
  let size = 4;
  while (size < count && size < max) size *= 2;
  return size;
}

/** Mélange (tirage au sort du tableau). */
export function shuffle<T>(items: T[], random = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

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

/** Tours suivants, vides au départ (avec la petite finale si demandée). */
export function emptyRounds(size: number, thirdPlace = false): BracketEntry[] {
  const entries: BracketEntry[] = [];
  const rounds = roundsFor(size);
  for (let round = 2; round <= rounds; round += 1) {
    for (let slot = 0; slot < size / 2 ** round; slot += 1) entries.push({ round, slot, teamA: null, teamB: null, winner: null, status: 'pending' });
  }
  if (thirdPlace && rounds >= 2) entries.push({ round: rounds, slot: 1, teamA: null, teamB: null, winner: null, status: 'pending' });
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
  // Perdant d'une rencontre jouée (aucun si qualifié d'office ou rencontre vide).
  const loser = (entry: BracketEntry) => (entry.status === 'done' && entry.teamA && entry.teamB ? (entry.winner === entry.teamA ? entry.teamB : entry.teamA) : null);
  for (let round = 1; round <= rounds; round += 1) {
    for (const entry of next.filter((e) => e.round === round).sort((a, b) => a.slot - b.slot)) {
      let known = true;
      if (round > 1) {
        // Petite finale : les perdants des deux demi-finales.
        const third = isThirdPlace(entry, rounds);
        const feedA = at(round - 1, third ? 0 : entry.slot * 2);
        const feedB = at(round - 1, third ? 1 : entry.slot * 2 + 1);
        const from = third ? loser : (feed: BracketEntry) => feed.winner;
        if (settled(feedA) && !entry.teamA) entry.teamA = from(feedA!);
        if (settled(feedB) && !entry.teamB) entry.teamB = from(feedB!);
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

/** Vainqueur, finaliste et 3e (petite finale) une fois les dernières rencontres jouées, sinon null. */
export function podium(entries: BracketEntry[], rounds: number): { winner: string | null; finalist: string | null; third: string | null } | null {
  const settled = (entry: BracketEntry | undefined) => entry?.status === 'done' || entry?.status === 'empty';
  const final = entries.find((entry) => entry.round === rounds && entry.slot === 0);
  const third = entries.find((entry) => isThirdPlace(entry, rounds));
  if (!settled(final) || (third && !settled(third))) return null;
  return { winner: final!.winner, finalist: final!.winner === final!.teamA ? final!.teamB : final!.teamA, third: third?.winner ?? null };
}

// --- Double élimination (Coupe Horus) ------------------------------------------------------------
//
// Tableau des gagnants : tours 1..n (n = log2(taille)). Tableau des perdants : tours LB+1..LB+2(n-1) :
//   - LB+1 : les perdants du 1er tour des gagnants, deux par deux ;
//   - LB+2k (k ≥ 1) : vainqueurs du tour perdants précédent contre les perdants du tour k+1 des gagnants ;
//   - LB+2k+1 : vainqueurs du tour perdants précédent, deux par deux.
// Grande finale (GF) : vainqueur des gagnants contre vainqueur des perdants, en un seul match (pas de
// « reset »). Bronze : le perdant de la finale des perdants.

export const LOSERS_BASE = 100;
export const GRAND_FINAL = 200;
export type BracketType = 'single' | 'double';

const isLosers = (round: number) => round > LOSERS_BASE && round < GRAND_FINAL;

/** Tableau complet d'une double élimination (1er tour placé, le reste vide). */
export function doubleBracket(seeds: string[], size: number): BracketEntry[] {
  const n = roundsFor(size);
  const entries = [...firstRound(seeds, size), ...emptyRounds(size)];
  for (let k = 1; k <= 2 * (n - 1); k += 1) {
    // Tours perdants 1 et 2 : taille / 4 rencontres, 3 et 4 : taille / 8, etc.
    const count = size / 2 ** (Math.floor((k + 1) / 2) + 1);
    for (let slot = 0; slot < count; slot += 1) entries.push({ round: LOSERS_BASE + k, slot, teamA: null, teamB: null, winner: null, status: 'pending' });
  }
  entries.push({ round: GRAND_FINAL, slot: 0, teamA: null, teamB: null, winner: null, status: 'pending' });
  return entries;
}

/** Fait avancer une double élimination (mêmes règles que advanceBracket pour les places vides et forfaits). */
export function advanceDouble(entries: BracketEntry[], size: number): BracketEntry[] {
  const n = roundsFor(size);
  const next = entries.map((entry) => ({ ...entry }));
  const at = (round: number, slot: number) => next.find((entry) => entry.round === round && entry.slot === slot);
  const settled = (entry: BracketEntry | undefined) => entry?.status === 'done' || entry?.status === 'empty';
  const winnerOf = (entry: BracketEntry) => entry.winner;
  const loserOf = (entry: BracketEntry) => (entry.status === 'done' && entry.teamA && entry.teamB ? (entry.winner === entry.teamA ? entry.teamB : entry.teamA) : null);

  const feeds = (entry: BracketEntry): [BracketEntry | undefined, (e: BracketEntry) => string | null, BracketEntry | undefined, (e: BracketEntry) => string | null] | null => {
    const { round, slot } = entry;
    if (round === 1) return null;
    if (round <= n) return [at(round - 1, slot * 2), winnerOf, at(round - 1, slot * 2 + 1), winnerOf];
    if (round === GRAND_FINAL) return [at(n, 0), winnerOf, at(LOSERS_BASE + 2 * (n - 1), 0), winnerOf];
    const k = round - LOSERS_BASE;
    if (k === 1) return [at(1, slot * 2), loserOf, at(1, slot * 2 + 1), loserOf];
    if (k % 2 === 0) return [at(round - 1, slot), winnerOf, at(k / 2 + 1, slot), loserOf];
    return [at(round - 1, slot * 2), winnerOf, at(round - 1, slot * 2 + 1), winnerOf];
  };

  const order = [...next].sort((a, b) => a.round - b.round || a.slot - b.slot);
  for (const entry of order) {
    let known = true;
    const feed = feeds(entry);
    if (feed) {
      const [feedA, fromA, feedB, fromB] = feed;
      if (settled(feedA) && !entry.teamA) entry.teamA = fromA(feedA!);
      if (settled(feedB) && !entry.teamB) entry.teamB = fromB(feedB!);
      known = settled(feedA) && settled(feedB);
    }
    if (!known || entry.status !== 'pending') continue;
    if (!entry.teamA && !entry.teamB) entry.status = 'empty';
    else if (!entry.teamA || !entry.teamB) {
      entry.winner = entry.teamA ?? entry.teamB;
      entry.status = 'done';
    }
  }
  return next;
}

/** Podium d'une double élimination : grande finale jouée, bronze = perdant de la finale des perdants. */
export function podiumDouble(entries: BracketEntry[], size: number): { winner: string | null; finalist: string | null; third: string | null } | null {
  const n = roundsFor(size);
  const settled = (entry: BracketEntry | undefined) => entry?.status === 'done' || entry?.status === 'empty';
  const final = entries.find((entry) => entry.round === GRAND_FINAL);
  if (!settled(final)) return null;
  const lbFinal = entries.find((entry) => entry.round === LOSERS_BASE + 2 * (n - 1));
  const third = lbFinal && lbFinal.status === 'done' && lbFinal.teamA && lbFinal.teamB ? (lbFinal.winner === lbFinal.teamA ? lbFinal.teamB : lbFinal.teamA) : null;
  return { winner: final!.winner, finalist: final!.winner === final!.teamA ? final!.teamB : final!.teamA, third };
}

/** Format en double élimination : la grande finale a le sien, tout le reste suit les autres matchs. */
export const bestOfDouble = (round: number, format: MatchFormat) => (round === GRAND_FINAL ? format.finalBestOf : format.bestOf);

/** Nom d'un tour en double élimination. */
export function roundNameDouble(round: number, size: number): string {
  const n = roundsFor(size);
  if (round === GRAND_FINAL) return 'Grande finale';
  if (isLosers(round)) {
    const k = round - LOSERS_BASE;
    return k === 2 * (n - 1) ? 'Finale des perdants' : `Perdants · tour ${k}`;
  }
  return round === n ? 'Finale des gagnants' : `Gagnants · ${roundName(round, n).toLowerCase()}`;
}

