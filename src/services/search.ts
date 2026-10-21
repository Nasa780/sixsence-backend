import { fromDbError } from '../errors.js';
import { supabase } from '../supabase.js';
import { normalizeName, rankPlayers } from './playerSearch.js';

/**
 * Recherche globale du site (GET /search?q=) : joueurs (pseudo, même stylisé) et équipes actives (nom
 * ou tag). Informations publiques seulement (jamais l'identifiant Activision). Index gardé en mémoire
 * 60 s : la recherche se fait pendant la frappe.
 */

const TTL = 60_000;
const LIMIT = 6;

interface IndexedPlayer {
  id: string;
  username: string;
  avatarUrl: string | null;
  points: number;
  position: number | null;
  team: { tag: string; color: string } | null;
  activisionId: null;
}

interface IndexedTeam {
  id: string;
  name: string;
  tag: string;
  color: string;
  logoUrl: string | null;
  points: number;
  position: number;
  size: number;
}

let cache: { at: number; players: IndexedPlayer[]; teams: IndexedTeam[] } | null = null;

async function index() {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const [users, profiles, teams, members] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').limit(10000),
    supabase.from('cod_profiles').select('user_id, points, wins, losses').limit(10000),
    supabase.from('teams').select('id, name, tag, color, logo_url, points, wins').is('disbanded_at', null).order('points', { ascending: false }).order('wins', { ascending: false }),
    supabase.from('team_members').select('user_id, team_id').limit(10000),
  ]);
  for (const result of [users, profiles, teams, members]) if (result.error) throw fromDbError(result.error);

  const teamRows = (teams.data ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null; points: number }[];
  const memberRows = (members.data ?? []) as { user_id: string; team_id: string }[];
  const teamById = new Map(teamRows.map((team) => [team.id, team]));
  const teamOf = new Map(memberRows.map((row) => [row.user_id, teamById.get(row.team_id)]));
  const sizes = new Map<string, number>();
  for (const row of memberRows) sizes.set(row.team_id, (sizes.get(row.team_id) ?? 0) + 1);

  // Place au classement : joueurs ayant joué, triés par points.
  const profileRows = (profiles.data ?? []) as { user_id: string; points: number; wins: number; losses: number }[];
  const ranked = profileRows.filter((p) => p.wins + p.losses > 0).sort((a, b) => b.points - a.points);
  const position = new Map(ranked.map((p, i) => [p.user_id, i + 1]));
  const points = new Map(profileRows.map((p) => [p.user_id, p.points]));

  cache = {
    at: Date.now(),
    players: ((users.data ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((user) => {
      const team = teamOf.get(user.id);
      return {
        id: user.id,
        username: user.username,
        avatarUrl: user.avatar_url,
        points: points.get(user.id) ?? 0,
        position: position.get(user.id) ?? null,
        team: team ? { tag: team.tag, color: team.color } : null,
        activisionId: null,
      };
    }),
    teams: teamRows.map((team, i) => ({
      id: team.id,
      name: team.name,
      tag: team.tag,
      color: team.color,
      logoUrl: team.logo_url,
      points: team.points,
      position: i + 1,
      size: sizes.get(team.id) ?? 0,
    })),
  };
  return cache;
}

/** Score d'une équipe : 0 tag exact, 1 nom exact, 2 début, 3 contient ; null sinon. */
function teamScore(team: IndexedTeam, term: string): number | null {
  const tag = normalizeName(team.tag);
  const name = normalizeName(team.name);
  if (tag === term) return 0;
  if (name === term) return 1;
  if (name.startsWith(term) || tag.startsWith(term)) return 2;
  if (name.includes(term)) return 3;
  return null;
}

export async function globalSearch(query: string) {
  const term = normalizeName(query.slice(0, 40));
  if (!term) return { players: [], teams: [] };
  const { players, teams } = await index();
  return {
    players: rankPlayers(players, term)
      .slice(0, LIMIT)
      .map(({ activisionId: _a, ...player }) => player),
    teams: teams
      .map((team) => ({ team, score: teamScore(team, term) }))
      .filter((entry): entry is { team: IndexedTeam; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score || a.team.position - b.team.position)
      .slice(0, LIMIT)
      .map((entry) => entry.team),
  };
}
