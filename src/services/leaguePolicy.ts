/**
 * Ligues de la Division : règles pures, testées dans leaguePolicy.test.ts.
 *
 *   - trois ligues : Élite (8 équipes), Ligue 1 (8 équipes), Ligue 2 (le reste) ;
 *   - activées à partir de LEAGUES_MIN_TEAMS équipes actives (avant : pas de ligue) ;
 *   - première répartition : selon le classement (8 premières en Élite, 8 suivantes en Ligue 1) ;
 *   - ensuite, à chaque fin de saison : les 2 premières de Ligue 1 et de Ligue 2 montent, les 2 dernières
 *     d'Élite et de Ligue 1 descendent ; une nouvelle équipe commence en Ligue 2.
 */

export const LEAGUES = ['elite', 'ligue1', 'ligue2'] as const;
export type League = (typeof LEAGUES)[number];
export const LEAGUE_SIZE = 8;
export const LEAGUES_MIN_TEAMS = 16;
export const LEAGUE_MOVES = 2;

export interface LeagueTeam {
  id: string;
  league: League | null;
  points: number;
  wins: number;
  createdAt: string;
}

const byRanking = (a: LeagueTeam, b: LeagueTeam) => b.points - a.points || b.wins - a.wins || a.createdAt.localeCompare(b.createdAt);

/** Nouvelle ligue de chaque équipe (null : ligues pas encore actives). */
export function assignLeagues(teams: LeagueTeam[]): Map<string, League | null> {
  const result = new Map<string, League | null>();
  if (teams.length < LEAGUES_MIN_TEAMS) {
    for (const team of teams) result.set(team.id, null);
    return result;
  }
  // Première activation : répartition selon le classement.
  if (!teams.some((team) => team.league)) {
    [...teams].sort(byRanking).forEach((team, index) => result.set(team.id, index < LEAGUE_SIZE ? 'elite' : index < 2 * LEAGUE_SIZE ? 'ligue1' : 'ligue2'));
    return result;
  }
  const of = (league: League) => teams.filter((team) => (team.league ?? 'ligue2') === league).sort(byRanking);
  const elite = of('elite');
  const ligue1 = of('ligue1');
  const ligue2 = of('ligue2');
  for (const team of teams) result.set(team.id, team.league ?? 'ligue2');
  // Montées et descentes (2 par frontière), sans vider une ligue.
  const moves = (upper: LeagueTeam[], lower: LeagueTeam[], up: League, down: League) => {
    const count = Math.min(LEAGUE_MOVES, upper.length, lower.length);
    for (const team of upper.slice(upper.length - count)) result.set(team.id, down);
    for (const team of lower.slice(0, count)) result.set(team.id, up);
  };
  moves(elite, ligue1, 'elite', 'ligue1');
  moves(ligue1, ligue2, 'ligue1', 'ligue2');
  // Élite incomplète (équipes dissoutes) : complétée par les meilleures de Ligue 1 restantes.
  const now = (league: League) => teams.filter((team) => result.get(team.id) === league).sort(byRanking);
  let eliteNow = now('elite');
  for (const team of now('ligue1')) {
    if (eliteNow.length >= LEAGUE_SIZE) break;
    result.set(team.id, 'elite');
    eliteNow = now('elite');
  }
  let ligue1Now = now('ligue1');
  for (const team of now('ligue2')) {
    if (ligue1Now.length >= LEAGUE_SIZE) break;
    result.set(team.id, 'ligue1');
    ligue1Now = now('ligue1');
  }
  return result;
}
