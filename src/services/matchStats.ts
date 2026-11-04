import { MATCH_REFEREES, roleOf } from '../auth.js';
import { config } from '../config.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { dm, notifyStaff } from './discord.js';
import { STATS_WINDOW_MS, captureReminderWindow, coversMatch, parseRows, summarizeStats, type MatchKind, type SeasonStatLine } from './matchStatsPolicy.js';

/**
 * Capture de fin de match (migrations 0065 et 0066). Le site lit la capture dans le navigateur et envoie Score, Élim.,
 * Poses et Désam. de chaque joueur ; l'image est gardée comme preuve. Une capture par map, envoyée pendant le match ou
 * dans les 24 h après ; les stats ne s'affichent qu'une fois le match terminé, un match annulé ne compte pas.
 * Contrôles : joueurs des deux équipes présents, même image refusée deux fois ; l'équipe adverse peut signaler,
 * un arbitre retire la capture. Aucun effet sur les points.
 */

export const parseKind = (value: unknown): MatchKind => {
  if (value === 'classe' || value === 'division') return value;
  throw new HttpError(400, 'INVALID_KIND', 'Type de match inconnu.');
};

const PLAYED = ['in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed'];

interface MatchInfo {
  status: string;
  completedAt: string | null;
  sides: [string[], string[]];
  maps: number;
  mapNames: string[];
}

async function matchInfo(kind: MatchKind, id: string): Promise<MatchInfo> {
  if (kind === 'classe') {
    const { data } = await supabase.from('cod_matches').select('status, completed_at, team_a, team_b, map').eq('id', id).maybeSingle();
    const match = data as { status: string; completed_at: string | null; team_a: string[]; team_b: string[]; map: string | null } | null;
    if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
    return { status: match.status, completedAt: match.completed_at, sides: [match.team_a, match.team_b], maps: 1, mapNames: [match.map ?? ''] };
  }
  const { data } = await supabase.from('team_matches').select('status, completed_at, roster_a, roster_b, scores, maps, best_of').eq('id', id).maybeSingle();
  const match = data as { status: string; completed_at: string | null; roster_a: string[]; roster_b: string[]; scores: unknown[] | null; maps: { map: string }[] | null; best_of: number | null } | null;
  if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
  const played = match.status === 'completed' ? (match.scores?.length ?? 1) : (match.best_of ?? 3);
  return { status: match.status, completedAt: match.completed_at, sides: [match.roster_a, match.roster_b], maps: Math.max(1, played), mapNames: (match.maps ?? []).map((item) => item.map) };
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

/** Capture encore acceptée : pendant le match, ou dans les 24 h après sa fin. */
function isOpen(info: MatchInfo): boolean {
  if (PLAYED.includes(info.status)) return true;
  return info.status === 'completed' && Boolean(info.completedAt) && Date.now() - new Date(info.completedAt as string).getTime() < STATS_WINDOW_MS;
}

export async function matchStats(kind: MatchKind, id: string, viewerId: string | null) {
  const info = await matchInfo(kind, id);
  const { data } = await supabase.from('match_player_stats').select('map_no, user_id, score, kills, plants, defuses').eq('match_kind', kind).eq('match_id', id).order('map_no').order('score', { ascending: false });
  const rows = (data ?? []) as { map_no: number; user_id: string; score: number; kills: number; plants: number; defuses: number }[];
  const players = await playersOf(info.sides);
  const inMatch = Boolean(viewerId && players.some((player) => player.id === viewerId));
  const canModerate = viewerId ? MATCH_REFEREES.includes(await roleOf(viewerId)) : false;
  const completed = info.status === 'completed';
  return {
    completed,
    maps: info.maps,
    mapNames: info.mapNames,
    players,
    // Les stats s'affichent à la fin du match ; avant, on sait seulement quelles maps ont leur capture.
    rows: completed ? rows.map((row) => ({ mapNo: row.map_no, userId: row.user_id, score: row.score, kills: row.kills, plants: row.plants, defuses: row.defuses })) : [],
    sentMaps: [...new Set(rows.map((row) => row.map_no))],
    canSubmit: inMatch && isOpen(info),
    canReport: inMatch && completed && rows.length > 0,
    canRemove: canModerate && rows.length > 0,
  };
}

export async function submitStats(kind: MatchKind, id: string, userId: string, body: unknown) {
  const info = await matchInfo(kind, id);
  const ids = [...info.sides[0], ...info.sides[1]];
  if (!ids.includes(userId)) throw new HttpError(403, 'NOT_IN_MATCH', 'Seuls les joueurs du match peuvent envoyer la capture.');
  if (!isOpen(info)) throw new HttpError(409, 'STATS_CLOSED', 'La capture s’envoie pendant le match ou dans les 24 h après.');
  const input = (body ?? {}) as { mapNo?: unknown; rows?: unknown; hash?: unknown };
  const mapNo = Number(input.mapNo ?? 1);
  if (!Number.isInteger(mapNo) || mapNo < 1 || mapNo > info.maps) throw new HttpError(400, 'INVALID_MAP', 'Map invalide.');
  const hash = typeof input.hash === 'string' ? input.hash : '';
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'INVALID_CAPTURE', 'Capture invalide.');
  const rows = parseRows(input.rows, ids);
  if (!rows) throw new HttpError(400, 'INVALID_STATS', 'Stats illisibles : envoie une capture plus nette.');
  if (!coversMatch(rows, info.sides)) throw new HttpError(400, 'WRONG_CAPTURE', 'Cette capture ne correspond pas à ce match : on n’y retrouve pas les joueurs des deux équipes.');
  const { count } = await supabase.from('match_player_stats').select('user_id', { count: 'exact', head: true }).eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo);
  if ((count ?? 0) > 0) throw new HttpError(409, 'STATS_EXISTS', 'La capture de cette map a déjà été envoyée.');
  const { error } = await supabase.from('match_captures').insert({ hash, match_kind: kind, match_id: id, map_no: mapNo, submitted_by: userId });
  if (error?.code === '23505') throw new HttpError(409, 'CAPTURE_USED', 'Cette capture a déjà été envoyée.');
  if (error) throw new HttpError(500, 'DB_ERROR', error.message);
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
  if (data) await notifyStaff(`📊 Stats de capture signalées : ${config.siteUrl}/${kind === 'classe' ? 'cod/match' : 'cod/equipes/match'}/${id}`);
  return { reported: true };
}

/** Un arbitre retire la capture d'une map : une autre peut être envoyée. */
export async function removeStats(kind: MatchKind, id: string, mapNo: number, userId: string) {
  if (!MATCH_REFEREES.includes(await roleOf(userId))) throw new HttpError(403, 'FORBIDDEN', 'Réservé à l’équipe.');
  unwrap(await supabase.from('match_player_stats').delete().eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo).select('user_id'));
  await supabase.from('match_captures').delete().eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo);
  return matchStats(kind, id, userId);
}

/** Bilan d'un joueur sur la saison en cours (profil) : les matchs annulés ne comptent pas. */
export async function playerStats(userId: string) {
  const { data: season } = await supabase.from('seasons').select('starts_at').eq('is_active', true).maybeSingle();
  let query = supabase.from('match_player_stats').select('match_kind, match_id, score, kills, plants, defuses').eq('user_id', userId).limit(2000);
  const start = (season as { starts_at: string } | null)?.starts_at;
  if (start) query = query.gte('created_at', start);
  const { data } = await query;
  const rows = (data ?? []) as (SeasonStatLine & { match_kind: MatchKind; match_id: string })[];
  const idsOf = (kind: MatchKind) => [...new Set(rows.filter((row) => row.match_kind === kind).map((row) => row.match_id))];
  const finished = async (table: string, ids: string[]) => {
    if (ids.length === 0) return new Set<string>();
    const { data: found } = await supabase.from(table).select('id').in('id', ids).eq('status', 'completed');
    return new Set(((found ?? []) as { id: string }[]).map((row) => row.id));
  };
  const [ranked, division] = await Promise.all([finished('cod_matches', idsOf('classe')), finished('team_matches', idsOf('division'))]);
  return summarizeStats(rows.filter((row) => (row.match_kind === 'classe' ? ranked : division).has(row.match_id)));
}

/**
 * Rappel unique (index.ts, toutes les 5 minutes) : un message privé aux joueurs d'un match terminé depuis 10 minutes
 * sans capture. Jamais répété, et coupé par la catégorie « Déroulé des matchs ».
 */
export async function remindCaptures(now = Date.now()): Promise<void> {
  const { from, to } = captureReminderWindow(now);
  const [ranked, division] = await Promise.all([
    supabase.from('cod_matches').select('id, team_a, team_b').eq('status', 'completed').gte('completed_at', from).lte('completed_at', to).limit(50),
    supabase.from('team_matches').select('id, roster_a, roster_b').eq('status', 'completed').gte('completed_at', from).lte('completed_at', to).limit(50),
  ]);
  const matches = [
    ...((ranked.data ?? []) as { id: string; team_a: string[]; team_b: string[] }[]).map((match) => ({ id: match.id, players: [...match.team_a, ...match.team_b], path: 'cod/match' })),
    ...((division.data ?? []) as { id: string; roster_a: string[]; roster_b: string[] }[]).map((match) => ({ id: match.id, players: [...match.roster_a, ...match.roster_b], path: 'cod/equipes/match' })),
  ];
  for (const match of matches) {
    const { count } = await supabase.from('match_player_stats').select('user_id', { count: 'exact', head: true }).eq('match_id', match.id);
    if ((count ?? 0) > 0) continue;
    const { data: first } = await supabase.rpc('app_claim', { p_key: `capture_rappel_${match.id}`, p_value: '1' });
    if (!first) continue;
    await dm(match.players, `📸 Ajoute ta capture pour tes stats : ${config.siteUrl}/${match.path}/${match.id}`, 'match');
  }
}
