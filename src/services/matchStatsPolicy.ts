/** Règles des stats lues sur les captures de fin de match, sans base (testées dans matchStatsPolicy.test.ts). */

export type MatchKind = 'classe' | 'division';
export interface StatRow {
  userId: string;
  score: number;
  kills: number;
  plants: number;
  defuses: number;
}

/** Une capture peut être envoyée pendant 24 h après la fin du match. */
export const STATS_WINDOW_MS = 24 * 3_600_000;

const count = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** Une ligne valide : le score d'un joueur est toujours un multiple de 5 sur le tableau du jeu. */
export function validRow(row: Partial<StatRow>): boolean {
  return count(row.score, 50000) && (row.score as number) % 5 === 0 && count(row.kills, 300) && count(row.plants, 30) && count(row.defuses, 30);
}

/** Lignes envoyées par le site : joueurs du match seulement, une fois chacun. Null si quelque chose ne va pas. */
export function parseRows(input: unknown, players: string[]): StatRow[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > players.length) return null;
  const seen = new Set<string>();
  const rows: StatRow[] = [];
  for (const raw of input as Partial<StatRow>[]) {
    const userId = raw?.userId;
    if (typeof userId !== 'string' || !players.includes(userId) || seen.has(userId) || !validRow(raw)) return null;
    seen.add(userId);
    rows.push({ userId, score: raw.score as number, kills: raw.kills as number, plants: raw.plants as number, defuses: raw.defuses as number });
  }
  return rows;
}

export interface SeasonStatLine {
  score: number;
  kills: number;
  plants: number;
  defuses: number;
}

/** Bilan d'un joueur sur ses maps : moyennes à une décimale, totaux, meilleures valeurs. */
export function summarizeStats(rows: SeasonStatLine[]) {
  const maps = rows.length;
  const sum = (pick: (row: SeasonStatLine) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const avg = (value: number) => (maps ? Math.round((value / maps) * 10) / 10 : 0);
  return {
    maps,
    kills: sum((row) => row.kills),
    avgKills: avg(sum((row) => row.kills)),
    avgScore: Math.round(avg(sum((row) => row.score))),
    plants: sum((row) => row.plants),
    defuses: sum((row) => row.defuses),
    bestKills: rows.reduce((best, row) => Math.max(best, row.kills), 0),
    bestScore: rows.reduce((best, row) => Math.max(best, row.score), 0),
  };
}
