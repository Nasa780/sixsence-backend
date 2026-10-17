/**
 * Matchs d'équipe (BO3, ou BO5 en finale de tournoi) : règles pures, testées dans teamMatchPolicy.test.ts.
 *
 *   - chaque map se joue en 6 manches gagnantes : un score valide est [6, 0..5] ou [0..5, 6] ;
 *   - toutes les maps sauf la dernière sont tirées au sort à la création ;
 *   - 1re déclaration : le nombre de maps nécessaire pour gagner (BO3 : maps 1 et 2 ; BO5 : maps 1 à 3),
 *     puis une map à la fois ;
 *   - égalité avant la dernière map (1-1 en BO3, 2-2 en BO5) : la map décisive est choisie par l'équipe
 *     qui a gagné le plus de manches sur les maps jouées ; égalité de manches : tirage au sort parmi
 *     les maps pas encore jouées ;
 *   - scores toujours exprimés du point de vue de l'équipe A.
 */

export type Side = 'A' | 'B';
export type MapScore = [number, number];

export const ROUNDS_TO_WIN = 6;

export function isValidMapScore(score: unknown): score is MapScore {
  if (!Array.isArray(score) || score.length !== 2) return false;
  const [a, b] = score;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return (a === ROUNDS_TO_WIN && b >= 0 && b < ROUNDS_TO_WIN) || (b === ROUNDS_TO_WIN && a >= 0 && a < ROUNDS_TO_WIN);
}

const mapWinner = ([a, b]: MapScore): Side => (a > b ? 'A' : 'B');

export interface SeriesState {
  mapsA: number;
  mapsB: number;
  winner: Side | null;
  /** Prochaine étape : 1re déclaration, map suivante, map décisive (à choisir puis déclarer), ou terminé. */
  phase: 'first' | 'next' | 'decider' | 'done';
  /** Nombre de scores attendus à la prochaine déclaration. */
  expected: number;
}

export function seriesState(scores: MapScore[], bestOf = 3): SeriesState {
  const need = Math.ceil(bestOf / 2);
  const mapsA = scores.filter((score) => mapWinner(score) === 'A').length;
  const mapsB = scores.length - mapsA;
  const winner: Side | null = mapsA >= need ? 'A' : mapsB >= need ? 'B' : null;
  if (winner) return { mapsA, mapsB, winner, phase: 'done', expected: 0 };
  if (scores.length === 0) return { mapsA, mapsB, winner, phase: 'first', expected: need };
  if (scores.length === bestOf - 1) return { mapsA, mapsB, winner, phase: 'decider', expected: 1 };
  return { mapsA, mapsB, winner, phase: 'next', expected: 1 };
}

/** Qui choisit la map décisive : le plus de manches gagnées sur les maps jouées, sinon tirage au sort. */
export function deciderPicker(scores: MapScore[]): Side | 'random' {
  const roundsA = scores.reduce((sum, [a]) => sum + a, 0);
  const roundsB = scores.reduce((sum, [, b]) => sum + b, 0);
  return roundsA > roundsB ? 'A' : roundsB > roundsA ? 'B' : 'random';
}

/** Vérifie une déclaration : le bon nombre de maps, chaque score valide, pas de map après la victoire. */
export function declarationError(confirmed: MapScore[], declared: unknown, bestOf = 3): string | null {
  const { phase, expected } = seriesState(confirmed, bestOf);
  if (phase === 'done') return 'Le match est déjà terminé.';
  if (!Array.isArray(declared) || declared.length !== expected) {
    if (phase === 'first') return `Déclare les scores des maps 1 à ${expected}.`;
    return phase === 'decider' ? 'Déclare le score de la map décisive.' : 'Déclare le score de la map suivante.';
  }
  if (!declared.every(isValidMapScore)) return 'Score invalide : une équipe doit avoir 6 manches, l’autre entre 0 et 5.';
  const all = [...confirmed, ...(declared as MapScore[])];
  for (let i = confirmed.length; i < all.length - 1; i += 1) {
    if (seriesState(all.slice(0, i + 1), bestOf).winner) return 'Le match était déjà gagné avant la dernière map déclarée.';
  }
  return null;
}

/** Scores d'une série complète (arbitrage) : chaque score valide, vainqueur exactement sur la dernière map. */
export function isCompleteSeries(scores: unknown, bestOf = 3): scores is MapScore[] {
  if (!Array.isArray(scores) || scores.length < Math.ceil(bestOf / 2) || scores.length > bestOf || !scores.every(isValidMapScore)) return false;
  return Boolean(seriesState(scores, bestOf).winner) && !seriesState(scores.slice(0, -1), bestOf).winner;
}

/** Tire au sort `count` maps différentes du pool, en évitant celles déjà jouées. */
export function pickMaps(pool: string[], count: number, exclude: string[] = [], random = Math.random): string[] {
  const left = pool.filter((map) => !exclude.includes(map));
  const picked: string[] = [];
  while (picked.length < count && left.length > 0) picked.push(left.splice(Math.floor(random() * left.length), 1)[0]!);
  return picked;
}

/** Enjeux façon Elo (K = 50, entre 5 et 45), identiques à team_match_stakes (migration 0026). */
export function stakes(pointsA: number, pointsB: number): Record<Side, { win: number; loss: number }> {
  const expectedA = 1 / (1 + 10 ** ((pointsB - pointsA) / 400));
  const clamp = (value: number) => Math.min(45, Math.max(5, Math.round(value)));
  return {
    A: { win: clamp(50 * (1 - expectedA)), loss: clamp(50 * expectedA) },
    B: { win: clamp(50 * expectedA), loss: clamp(50 * (1 - expectedA)) },
  };
}
