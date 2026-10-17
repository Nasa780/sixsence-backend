/**
 * Matchs d'équipe (BO3 en 4v4) : règles pures, testées dans teamMatchPolicy.test.ts.
 *
 *   - chaque map se joue en 6 manches gagnantes : un score valide est [6, 0..5] ou [0..5, 6] ;
 *   - maps 1 et 2 tirées au sort, déclarées ensemble ; 2-0 : match terminé ;
 *   - 1-1 : la map 3 est choisie par l'équipe qui a gagné le plus de manches sur les deux
 *     premières maps ; égalité : map tirée au sort parmi celles pas encore jouées ;
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
  /** Prochaine étape : déclarer les maps 1 et 2, choisir puis déclarer la map 3, ou terminé. */
  phase: 'maps12' | 'map3' | 'done';
  /** Nombre de scores attendus à la prochaine déclaration. */
  expected: number;
}

export function seriesState(scores: MapScore[]): SeriesState {
  const mapsA = scores.filter((score) => mapWinner(score) === 'A').length;
  const mapsB = scores.length - mapsA;
  const winner: Side | null = mapsA >= 2 ? 'A' : mapsB >= 2 ? 'B' : null;
  if (winner) return { mapsA, mapsB, winner, phase: 'done', expected: 0 };
  if (scores.length === 0) return { mapsA, mapsB, winner, phase: 'maps12', expected: 2 };
  return { mapsA, mapsB, winner, phase: 'map3', expected: 1 };
}

/** Qui choisit la map 3 (après 1-1) : le plus de manches gagnées, sinon tirage au sort. */
export function map3Picker(scores: MapScore[]): Side | 'random' {
  const roundsA = scores.slice(0, 2).reduce((sum, [a]) => sum + a, 0);
  const roundsB = scores.slice(0, 2).reduce((sum, [, b]) => sum + b, 0);
  return roundsA > roundsB ? 'A' : roundsB > roundsA ? 'B' : 'random';
}

/** Vérifie une déclaration : le bon nombre de maps, chaque score valide. Renvoie un message d'erreur ou null. */
export function declarationError(confirmed: MapScore[], declared: unknown): string | null {
  const { phase, expected } = seriesState(confirmed);
  if (phase === 'done') return 'Le match est déjà terminé.';
  if (!Array.isArray(declared) || declared.length !== expected) {
    return expected === 2 ? 'Déclare les scores des maps 1 et 2.' : 'Déclare le score de la map 3.';
  }
  if (!declared.every(isValidMapScore)) return 'Score invalide : une équipe doit avoir 6 manches, l’autre entre 0 et 5.';
  return null;
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
