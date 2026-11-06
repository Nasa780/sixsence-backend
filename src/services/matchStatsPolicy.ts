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

/**
 * Une capture doit montrer ce match : au moins la moitié de chaque équipe (au moins un joueur de chacune).
 * Écarte les captures d'un autre match, sauf si les mêmes joueurs ont rejoué ensemble.
 */
export function coversMatch(rows: { userId: string }[], sides: [string[], string[]]): boolean {
  const ids = new Set(rows.map((row) => row.userId));
  return sides.every((side) => {
    const found = side.filter((id) => ids.has(id)).length;
    return found >= 1 && found * 2 >= side.length;
  });
}

/** Rappel de capture : matchs terminés depuis 10 minutes à 1 heure (au-delà, on ne relance plus). */
export function captureReminderWindow(now: number): { from: string; to: string } {
  return { from: new Date(now - 60 * 60_000).toISOString(), to: new Date(now - 10 * 60_000).toISOString() };
}

/** Un match de Recherche et Destruction s'arrête au plus tard à 2 x manches à gagner - 1. */
export const maxRounds = (roundsToWin: number): number => 2 * roundsToWin - 1;

/**
 * Chiffres possibles sur une map : en Recherche et Destruction, on meurt une fois par manche et une seule bombe est posée.
 * Le site lit la capture, le serveur ne voit que les chiffres : ce contrôle écarte les valeurs impossibles.
 */
export function plausibleRows(rows: StatRow[], sides: [string[], string[]], roundsToWin: number): boolean {
  const rounds = maxRounds(roundsToWin);
  const total = (list: StatRow[], pick: (row: StatRow) => number) => list.reduce((sum, row) => sum + pick(row), 0);
  const killsOk = sides.every((side, index) => {
    const enemies = sides[index === 0 ? 1 : 0].length;
    return total(rows.filter((row) => side.includes(row.userId)), (row) => row.kills) <= rounds * enemies;
  });
  return killsOk && total(rows, (row) => row.plants) <= rounds && total(rows, (row) => row.defuses) <= rounds;
}

/** Une seconde capture montre la même map : la plupart des joueurs déjà enregistrés doivent y avoir les mêmes chiffres. */
export function sameCapture(existing: StatRow[], rows: StatRow[]): boolean {
  const common = rows.flatMap((row) => {
    const known = existing.find((item) => item.userId === row.userId);
    return known ? [{ row, known }] : [];
  });
  const same = common.filter(({ row, known }) => row.score === known.score && row.kills === known.kills).length;
  return common.length > 0 && same * 2 >= common.length;
}

/** Maps sans capture, ou avec des joueurs manquants. */
export function openMaps(maps: number, rows: { map_no: number }[], players: number): number[] {
  return Array.from({ length: maps }, (_, index) => index + 1).filter((no) => rows.filter((row) => row.map_no === no).length < players);
}

/** Texte du rappel de capture : précise la map quand le match en compte plusieurs. */
export function captureReminderText(url: string, open: number[], maps: number): string {
  if (maps === 1) return `📸 Ajoute ta capture pour tes stats : ${url}`;
  const list = open.length > 1 ? `des maps ${open.slice(0, -1).join(', ')} et ${open[open.length - 1]}` : `de la map ${open[0]}`;
  return `📸 Il manque la capture ${list} pour tes stats : ${url}`;
}

export interface MatchLine extends SeasonStatLine {
  match_id: string;
}

/** Chiffres d'un joueur par match, toutes maps additionnées : historique du profil. */
export function statsByMatch(rows: MatchLine[]): Record<string, SeasonStatLine> {
  const matches: Record<string, SeasonStatLine> = {};
  for (const { match_id: id, score, kills, plants, defuses } of rows) {
    const line = (matches[id] ??= { score: 0, kills: 0, plants: 0, defuses: 0 });
    line.score += score;
    line.kills += kills;
    line.plants += plants;
    line.defuses += defuses;
  }
  return matches;
}

/** Maps minimum pour le record des objectifs : un seul bon match ne suffit pas. */
export const OBJECTIVE_MIN_MAPS = 10;

/** Meilleure moyenne de poses + désamorçages par map (une décimale). À égalité, le joueur qui a le plus de maps. */
export function objectiveLeader(rows: { user_id: string; plants: number; defuses: number }[], minMaps = OBJECTIVE_MIN_MAPS): { userId: string; value: number; maps: number } | null {
  const totals = new Map<string, { maps: number; objectives: number }>();
  for (const row of rows) {
    const total = totals.get(row.user_id) ?? { maps: 0, objectives: 0 };
    total.maps += 1;
    total.objectives += row.plants + row.defuses;
    totals.set(row.user_id, total);
  }
  const ranked = [...totals]
    .filter(([, total]) => total.maps >= minMaps && total.objectives > 0)
    .map(([userId, total]) => ({ userId, average: total.objectives / total.maps, maps: total.maps }))
    .sort((a, b) => b.average - a.average || b.maps - a.maps);
  const first = ranked[0];
  return first ? { userId: first.userId, value: Math.round(first.average * 10) / 10, maps: first.maps } : null;
}

export interface PlayerTotal {
  userId: string;
  maps: number;
  score: number;
  kills: number;
  plants: number;
  defuses: number;
}

/** Totaux de chaque joueur sur ses maps. */
export function playerTotals(rows: (SeasonStatLine & { user_id: string })[]): PlayerTotal[] {
  const totals = new Map<string, PlayerTotal>();
  for (const row of rows) {
    const total = totals.get(row.user_id) ?? { userId: row.user_id, maps: 0, score: 0, kills: 0, plants: 0, defuses: 0 };
    total.maps += 1;
    total.score += row.score;
    total.kills += row.kills;
    total.plants += row.plants;
    total.defuses += row.defuses;
    totals.set(row.user_id, total);
  }
  return [...totals.values()];
}

/** Meilleur joueur d'une coupe : le plus gros score cumulé, puis le plus d'élim. */
export function cupBest(rows: (SeasonStatLine & { user_id: string })[]): PlayerTotal | null {
  return playerTotals(rows).sort((a, b) => b.score - a.score || b.kills - a.kills)[0] ?? null;
}

/** Classements de stats : moyennes par map à une décimale, joueurs d'au moins minMaps maps seulement. */
export function statsBoard(rows: (SeasonStatLine & { user_id: string })[], minMaps = OBJECTIVE_MIN_MAPS) {
  const average = (value: number, maps: number) => Math.round((value / maps) * 10) / 10;
  return playerTotals(rows)
    .filter((total) => total.maps >= minMaps)
    .map((total) => ({
      ...total,
      avgKills: average(total.kills, total.maps),
      avgScore: Math.round(total.score / total.maps),
      avgObjectives: average(total.plants + total.defuses, total.maps),
    }));
}
