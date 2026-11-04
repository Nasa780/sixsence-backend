import { MATCH_REFEREES, roleOf } from '../auth.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { notifyStaff } from './discord.js';
import { STATS_WINDOW_MS, parseRows, summarizeStats, type MatchKind, type SeasonStatLine } from './matchStatsPolicy.js';

/**
 * Stats lues sur la capture de fin de match (migration 0065). Le site lit la capture dans le navigateur et envoie
 * Score, Élim., Poses et Désam. de chaque joueur ; une seule capture par map. Le joueur qui envoie valide, l'équipe
 * adverse peut signaler une erreur au staff, un arbitre peut retirer la capture. Aucun effet sur les points.
 */

export const parseKind = (value: unknown): MatchKind => {
  if (value === 'classe' || value === 'division') return value;
  throw new HttpError(400, 'INVALID_KIND', 'Type de match inconnu.');
};

interface MatchInfo {
  status: string;
  completedAt: string | null;
  sides: [string[], string[]];
  maps: number;
}

async function matchInfo(kind: MatchKind, id: string): Promise<MatchInfo> {
  if (kind === 'classe') {
    const { data } = await supabase.from('cod_matches').select('status, completed_at, team_a, team_b').eq('id', id).maybeSingle();
    const match = data as { status: string; completed_at: string | null; team_a: string[]; team_b: string[] } | null;
    if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
    return { status: match.status, completedAt: match.completed_at, sides: [match.team_a, match.team_b], maps: 1 };
  }
  const { data } = await supabase.from('team_matches').select('status, completed_at, roster_a, roster_b, scores').eq('id', id).maybeSingle();
  const match = data as { status: string; completed_at: string | null; roster_a: string[]; roster_b: string[]; scores: unknown[] | null } | null;
  if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
  return { status: match.status, completedAt: match.completed_at, sides: [match.roster_a, match.roster_b], maps: Math.max(1, match.scores?.length ?? 1) };
}

/** Joueurs du match avec l'identifiant Activision (le site s'en sert pour reconnaître les lignes de la capture). */
async function playersOf(sides: [string[], string[]]) {
  const ids = [...sides[0], ...sides[1]];
  const [users, profiles] = await Promise.all([
    supabase.from('users').select('id, username').in('id', ids),
    supabase.from('cod_profiles').select('user_id, activision_id').in('user_id', ids),
  ]);
  const names = new Map(((users.data ?? []) as { id: string; username: string }[]).map((user) => [user.id, user.username]));
  const activision = new Map(((profiles.data ?? []) as { user_id: string; activision_id: string | null }[]).map((row) => [row.user_id, row.activision_id]));
  return ids.map((id) => ({ id, username: names.get(id) ?? 'Joueur', activision: activision.get(id) ?? null, side: sides[0].includes(id) ? ('A' as const) : ('B' as const) }));
}

export async function matchStats(kind: MatchKind, id: string, viewerId: string | null) {
  const info = await matchInfo(kind, id);
  const { data } = await supabase.from('match_player_stats').select('map_no, user_id, score, kills, plants, defuses, submitted_by').eq('match_kind', kind).eq('match_id', id).order('map_no').order('score', { ascending: false });
  const rows = (data ?? []) as { map_no: number; user_id: string; score: number; kills: number; plants: number; defuses: number; submitted_by: string | null }[];
  const players = await playersOf(info.sides);
  const inMatch = Boolean(viewerId && players.some((player) => player.id === viewerId));
  const open = info.status === 'completed' && Boolean(info.completedAt) && Date.now() - new Date(info.completedAt as string).getTime() < STATS_WINDOW_MS;
  const canModerate = viewerId ? MATCH_REFEREES.includes(await roleOf(viewerId)) : false;
  return {
    completed: info.status === 'completed',
    maps: info.maps,
    players,
    rows: rows.map((row) => ({ mapNo: row.map_no, userId: row.user_id, score: row.score, kills: row.kills, plants: row.plants, defuses: row.defuses })),
    canSubmit: inMatch && open,
    canReport: inMatch && rows.length > 0,
    canRemove: canModerate && rows.length > 0,
  };
}

export async function submitStats(kind: MatchKind, id: string, userId: string, body: unknown) {
  const info = await matchInfo(kind, id);
  const ids = [...info.sides[0], ...info.sides[1]];
  if (!ids.includes(userId)) throw new HttpError(403, 'NOT_IN_MATCH', 'Seuls les joueurs du match peuvent envoyer la capture.');
  if (info.status !== 'completed' || !info.completedAt) throw new HttpError(409, 'MATCH_NOT_FINISHED', 'Le match n’est pas terminé.');
  if (Date.now() - new Date(info.completedAt).getTime() > STATS_WINDOW_MS) throw new HttpError(409, 'STATS_CLOSED', 'La capture s’envoie dans les 24 h après le match.');
  const input = (body ?? {}) as { mapNo?: unknown; rows?: unknown };
  const mapNo = Number(input.mapNo ?? 1);
  if (!Number.isInteger(mapNo) || mapNo < 1 || mapNo > info.maps) throw new HttpError(400, 'INVALID_MAP', 'Map invalide.');
  const rows = parseRows(input.rows, ids);
  if (!rows) throw new HttpError(400, 'INVALID_STATS', 'Stats illisibles : envoie une capture plus nette.');
  const { count } = await supabase.from('match_player_stats').select('user_id', { count: 'exact', head: true }).eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo);
  if ((count ?? 0) > 0) throw new HttpError(409, 'STATS_EXISTS', 'La capture de cette map a déjà été envoyée.');
  unwrap(
    await supabase
      .from('match_player_stats')
      .insert(rows.map((row) => ({ match_kind: kind, match_id: id, map_no: mapNo, user_id: row.userId, score: row.score, kills: row.kills, plants: row.plants, defuses: row.defuses, submitted_by: userId })))
      .select('user_id'),
  );
  return matchStats(kind, id, userId);
}

/** Un joueur du match signale une erreur : le staff regarde et peut retirer la capture. */
export async function reportStats(kind: MatchKind, id: string, userId: string) {
  const info = await matchInfo(kind, id);
  if (![...info.sides[0], ...info.sides[1]].includes(userId)) throw new HttpError(403, 'NOT_IN_MATCH', 'Seuls les joueurs du match peuvent signaler.');
  const { data } = await supabase.rpc('app_claim', { p_key: `stats_report_${kind}_${id}`, p_value: userId });
  if (data) await notifyStaff(`📊 Stats de capture signalées : https://www.sixsence.fr/${kind === 'classe' ? 'cod/match' : 'cod/equipes/match'}/${id}`);
  return { reported: true };
}

/** Un arbitre retire la capture d'une map : elle peut être renvoyée. */
export async function removeStats(kind: MatchKind, id: string, mapNo: number, userId: string) {
  if (!MATCH_REFEREES.includes(await roleOf(userId))) throw new HttpError(403, 'FORBIDDEN', 'Réservé à l’équipe.');
  unwrap(await supabase.from('match_player_stats').delete().eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo).select('user_id'));
  return matchStats(kind, id, userId);
}

/** Bilan d'un joueur sur la saison en cours (profil). */
export async function playerStats(userId: string) {
  const { data: season } = await supabase.from('seasons').select('starts_at').eq('is_active', true).maybeSingle();
  let query = supabase.from('match_player_stats').select('score, kills, plants, defuses').eq('user_id', userId).limit(2000);
  const start = (season as { starts_at: string } | null)?.starts_at;
  if (start) query = query.gte('created_at', start);
  const { data } = await query;
  return summarizeStats((data ?? []) as SeasonStatLine[]);
}
