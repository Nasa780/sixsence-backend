import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { LEAGUES_MIN_TEAMS, assignLeagues, type League, type LeagueTeam } from './leaguePolicy.js';

/**
 * Ligues de la Division (règles dans leaguePolicy.ts) : répartition calculée sur le classement avant la
 * remise à zéro de fin de saison, ligue de la saison archivée dans team_season_results, et première
 * activation depuis l'admin dès LEAGUES_MIN_TEAMS équipes actives.
 */

async function activeTeams(): Promise<LeagueTeam[]> {
  const rows = (unwrap(await supabase.from('teams').select('id, league, points, wins, created_at').is('disbanded_at', null).is('cup_tournament', null)) ?? []) as {
    id: string;
    league: League | null;
    points: number;
    wins: number;
    created_at: string;
  }[];
  return rows.map((row) => ({ id: row.id, league: row.league, points: row.points, wins: row.wins, createdAt: row.created_at }));
}

async function write(teams: LeagueTeam[], next: Map<string, League | null>): Promise<number> {
  let changed = 0;
  for (const team of teams) {
    const league = next.get(team.id) ?? null;
    if (league === team.league) continue;
    unwrap(await supabase.from('teams').update({ league }).eq('id', team.id));
    changed += 1;
  }
  return changed;
}

/** État des ligues pour le site et l'admin. */
export async function leagueState() {
  const teams = await activeTeams();
  return { active: teams.some((team) => team.league), teams: teams.length, minTeams: LEAGUES_MIN_TEAMS };
}

/** Admin : première répartition (ligues pas encore actives, au moins 16 équipes). */
export async function activateLeagues() {
  const teams = await activeTeams();
  if (teams.some((team) => team.league)) throw new HttpError(409, 'LEAGUES_ACTIVE', 'Les ligues sont déjà actives : elles évoluent à chaque fin de saison.');
  if (teams.length < LEAGUES_MIN_TEAMS) throw new HttpError(409, 'NOT_ENOUGH_TEAMS', `Il faut au moins ${LEAGUES_MIN_TEAMS} équipes actives (${teams.length} aujourd’hui).`);
  await write(teams, assignLeagues(teams));
  return leagueState();
}

/**
 * Fin de saison : à appeler AVANT team_close_season (classement encore intact). Renvoie de quoi archiver
 * la ligue jouée et appliquer les montées et descentes une fois la saison close.
 */
export async function prepareLeagueMoves() {
  const teams = await activeTeams();
  if (!teams.some((team) => team.league)) {
    // Ligues pas encore actives : rien à archiver, première répartition si le seuil est atteint.
    return async (_seasonId: number) => {
      if (teams.length >= LEAGUES_MIN_TEAMS) await write(teams, assignLeagues(teams));
    };
  }
  const next = assignLeagues(teams);
  return async (seasonId: number) => {
    for (const team of teams) {
      await supabase.from('team_season_results').update({ league: team.league ?? 'ligue2' }).eq('season_id', seasonId).eq('team_id', team.id);
    }
    await write(teams, next);
  };
}
