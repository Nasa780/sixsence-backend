import { MATCH_REFEREES, roleOf } from '../auth.js';
import { config } from '../config.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { discord, notifyStaff } from './discord.js';
import { roundsToWin } from './teamMatchPolicy.js';
import { logToDiscord } from './siteLog.js';
import { withBestPlayer, withRoundScore } from './resultCardPolicy.js';
import { STATS_WINDOW_MS, captureReminderText, coversMatch, cupBest, OBJECTIVE_MIN_MAPS, objectiveLeader, openMaps, parseRows, plausibleRows, sameCapture, statsBoard, statsByMatch, summarizeStats, validRounds, validRow, type MatchKind, type SeasonStatLine, type StatRow } from './matchStatsPolicy.js';

/**
 * Capture de fin de match (migrations 0065, 0066 et 0068). Le site lit la capture dans le navigateur et envoie Score,
 * Élim., Poses et Désam. de chaque joueur ; l'image est gardée comme preuve. Une capture par map, envoyée pendant le match
 * ou dans les 24 h après, complétée par une autre si des joueurs manquent ; les stats ne s'affichent qu'une fois le match
 * terminé, un match annulé ne compte pas. Contrôles : joueurs des deux équipes présents, chiffres possibles, même image
 * refusée sur un autre match ; un joueur signale une ligne, un arbitre la corrige ou retire la capture. Aucun effet sur les points.
 */

export const parseKind = (value: unknown): MatchKind => {
  if (value === 'classe' || value === 'division') return value;
  throw new HttpError(400, 'INVALID_KIND', 'Type de match inconnu.');
};

const PLAYED = ['in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed'];
const PROOF_BUCKETS: Record<MatchKind, string> = { classe: 'match-proofs', division: 'team-match-proofs' };
/** Lien d'une capture : valable une heure. */
const CAPTURE_URL_SECONDS = 3600;

interface MatchInfo {
  status: string;
  completedAt: string | null;
  sides: [string[], string[]];
  maps: number;
  mapNames: string[];
  /** Manches à gagner sur une map : 8 en BO1, 6 en BO3 et BO5. */
  roundsToWin: number;
  /** Score de chaque map, déjà connu en Division une fois le match terminé. */
  mapScores: [number, number][];
  /** Forfait ou match amical : pas de stats, donc pas de capture demandée. */
  noStats: boolean;
}

async function matchInfo(kind: MatchKind, id: string): Promise<MatchInfo> {
  if (kind === 'classe') {
    const { data } = await supabase.from('cod_matches').select('status, completed_at, team_a, team_b, map').eq('id', id).maybeSingle();
    const match = data as { status: string; completed_at: string | null; team_a: string[]; team_b: string[]; map: string | null } | null;
    if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
    return { status: match.status, completedAt: match.completed_at, sides: [match.team_a, match.team_b], maps: 1, mapNames: [match.map ?? ''], roundsToWin: roundsToWin(1), mapScores: [], noStats: false };
  }
  const { data } = await supabase.from('team_matches').select('status, completed_at, roster_a, roster_b, scores, maps, best_of, forfeit, friendly').eq('id', id).maybeSingle();
  const match = data as { status: string; completed_at: string | null; roster_a: string[]; roster_b: string[]; scores: [number, number][] | null; maps: { map: string }[] | null; best_of: number | null; forfeit: boolean; friendly: boolean } | null;
  if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
  const played = match.status === 'completed' ? (match.scores?.length ?? 1) : (match.best_of ?? 3);
  return { status: match.status, completedAt: match.completed_at, sides: [match.roster_a, match.roster_b], maps: Math.max(1, played), mapNames: (match.maps ?? []).map((item) => item.map), roundsToWin: roundsToWin(match.best_of ?? 3), mapScores: match.scores ?? [], noStats: match.forfeit || match.friendly };
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
  if (info.noStats) return false;
  if (PLAYED.includes(info.status)) return true;
  return info.status === 'completed' && Boolean(info.completedAt) && Date.now() - new Date(info.completedAt as string).getTime() < STATS_WINDOW_MS;
}

/** Carte de résultat sur Discord : le meilleur joueur du match, dès qu'une capture le donne. Sans effet sur la capture si ça échoue. */
export async function refreshResultCard(kind: MatchKind, id: string): Promise<void> {
  const channel = config.discord.resultsChannelId;
  if (!channel) return;
  const { data: match } = await supabase.from(kind === 'classe' ? 'cod_matches' : 'team_matches').select('discord_result_message').eq('id', id).maybeSingle();
  const messageId = (match as { discord_result_message: string | null } | null)?.discord_result_message;
  if (!messageId) return;
  const { data } = await supabase.from('match_player_stats').select('user_id, score, kills, plants, defuses').eq('match_kind', kind).eq('match_id', id);
  const rows = (data ?? []) as (SeasonStatLine & { user_id: string })[];
  const best = cupBest(rows);
  const player = best ? await playerCard(best.userId) : null;
  const line = best && player ? { username: player.username, avatarUrl: player.avatarUrl, score: best.score, kills: best.kills, plants: best.plants, defuses: best.defuses } : null;
  const message = (await discord(`/channels/${channel}/messages/${messageId}`)) as { embeds?: { image?: { url?: string } }[] } | null;
  const embed = message?.embeds?.[0];
  if (!embed?.image?.url) return;
  let url = withBestPlayer(embed.image.url, line);
  // Classé : score de manches lu sur la capture (Division et coupes ont déjà le score de chaque map).
  if (kind === 'classe') {
    const { data: captures } = await supabase.from('match_captures').select('rounds').eq('match_kind', kind).eq('match_id', id).not('rounds', 'is', null).order('created_at').limit(1);
    url = withRoundScore(url, rows.length ? ((captures ?? []) as { rounds: number[] }[])[0]?.rounds ?? null : null);
  }
  await discord(`/channels/${channel}/messages/${messageId}`, { method: 'PATCH', body: { embeds: [{ ...embed, image: { url } }] } });
}

const updateCardSoon = (kind: MatchKind, id: string) => void refreshResultCard(kind, id).catch((error) => console.warn('[stats] carte de résultat', (error as Error).message));

/** Lignes enregistrées d'une map. */
async function mapRows(kind: MatchKind, id: string, mapNo: number): Promise<StatRow[]> {
  const { data } = await supabase.from('match_player_stats').select('user_id, score, kills, plants, defuses').eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo);
  return ((data ?? []) as { user_id: string; score: number; kills: number; plants: number; defuses: number }[]).map(({ user_id: userId, ...stats }) => ({ userId, ...stats }));
}

/** Images des captures, map par map : vues par les joueurs du match et les arbitres, comme les preuves. */
async function captureLinks(kind: MatchKind, id: string) {
  const { data } = await supabase.from('match_captures').select('map_no, proof_path').eq('match_kind', kind).eq('match_id', id).not('proof_path', 'is', null).order('created_at');
  const rows = (data ?? []) as { map_no: number; proof_path: string }[];
  if (rows.length === 0) return [];
  const { data: links } = await supabase.storage.from(PROOF_BUCKETS[kind]).createSignedUrls(rows.map((row) => row.proof_path), CAPTURE_URL_SECONDS);
  return rows.flatMap((row, index) => {
    const url = links?.[index]?.signedUrl;
    return url ? [{ mapNo: row.map_no, url }] : [];
  });
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
    roundsToWin: info.roundsToWin,
    mapScores: info.mapScores,
    players,
    // Les stats s'affichent à la fin du match ; avant, on sait seulement quelles maps ont leur capture.
    rows: completed ? rows.map((row) => ({ mapNo: row.map_no, userId: row.user_id, score: row.score, kills: row.kills, plants: row.plants, defuses: row.defuses })) : [],
    sentMaps: [...new Set(rows.map((row) => row.map_no))],
    // Maps sans capture, ou à compléter parce que des joueurs manquent.
    openMaps: openMaps(info.maps, rows, players.length),
    captures: completed && (inMatch || canModerate) ? await captureLinks(kind, id) : [],
    canSubmit: inMatch && isOpen(info),
    canReport: inMatch && completed && rows.length > 0,
    canRemove: canModerate && rows.length > 0,
  };
}

export async function submitStats(kind: MatchKind, id: string, userId: string, body: unknown) {
  const info = await matchInfo(kind, id);
  const ids = [...info.sides[0], ...info.sides[1]];
  if (!ids.includes(userId)) throw new HttpError(403, 'NOT_IN_MATCH', 'Seuls les joueurs du match peuvent envoyer la capture.');
  if (info.noStats) throw new HttpError(409, 'STATS_CLOSED', 'Un forfait ou un match amical ne compte pas dans les stats perso.');
  if (!isOpen(info)) throw new HttpError(409, 'STATS_CLOSED', 'La capture s’envoie pendant le match ou dans les 24 h après.');
  const input = (body ?? {}) as { mapNo?: unknown; rows?: unknown; hash?: unknown; rounds?: unknown };
  const mapNo = Number(input.mapNo ?? 1);
  if (!Number.isInteger(mapNo) || mapNo < 1 || mapNo > info.maps) throw new HttpError(400, 'INVALID_MAP', 'Map invalide.');
  const hash = typeof input.hash === 'string' ? input.hash : '';
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'INVALID_CAPTURE', 'Capture invalide.');
  const rows = parseRows(input.rows, ids);
  if (!rows) throw new HttpError(400, 'INVALID_STATS', 'Stats illisibles : envoie une capture plus nette.');
  const existing = await mapRows(kind, id, mapNo);
  // Map déjà envoyée : la capture ne sert qu'à ajouter les joueurs qui manquent.
  const added = rows.filter((row) => !existing.some((item) => item.userId === row.userId));
  if (existing.length === 0 && !coversMatch(rows, info.sides)) throw new HttpError(400, 'WRONG_CAPTURE', 'Cette capture ne correspond pas à ce match : on n’y retrouve pas les joueurs des deux équipes.');
  if (added.length === 0) throw new HttpError(409, 'STATS_EXISTS', 'La capture de cette map a déjà été envoyée.');
  if (existing.length > 0 && !sameCapture(existing, rows)) throw new HttpError(400, 'WRONG_CAPTURE', 'Cette capture ne correspond pas à celle déjà envoyée pour cette map.');
  if (!plausibleRows([...existing, ...added], info.sides, info.roundsToWin)) throw new HttpError(400, 'IMPOSSIBLE_STATS', 'Ces chiffres sont impossibles pour ce match : envoie une capture plus nette.');
  const { data: used } = await supabase.from('match_captures').select('match_kind, match_id, map_no').eq('hash', hash).maybeSingle();
  const seen = used as { match_kind: string; match_id: string; map_no: number } | null;
  if (seen && (seen.match_kind !== kind || seen.match_id !== id || seen.map_no !== mapNo)) throw new HttpError(409, 'CAPTURE_USED', 'Cette capture a déjà été envoyée.');
  if (!seen) {
    const { error } = await supabase.from('match_captures').insert({ hash, match_kind: kind, match_id: id, map_no: mapNo, submitted_by: userId, rounds: validRounds(input.rounds, info.roundsToWin) });
    if (error?.code === '23505') throw new HttpError(409, 'CAPTURE_USED', 'Cette capture a déjà été envoyée.');
    if (error) throw new HttpError(500, 'DB_ERROR', error.message);
  }
  unwrap(
    await supabase
      .from('match_player_stats')
      .upsert(
        added.map((row) => ({ match_kind: kind, match_id: id, map_no: mapNo, user_id: row.userId, score: row.score, kills: row.kills, plants: row.plants, defuses: row.defuses, submitted_by: userId })),
        { onConflict: 'match_kind,match_id,map_no,user_id', ignoreDuplicates: true },
      )
      .select('user_id'),
  );
  updateCardSoon(kind, id);
  return matchStats(kind, id, userId);
}

/** Relie l'image gardée comme preuve à la capture de sa map. */
export async function attachCaptureProof(kind: MatchKind, id: string, mapNo: number, userId: string, body: unknown) {
  const path = (body as { path?: unknown } | null)?.path;
  if (typeof path !== 'string' || !path.startsWith(`${id}/${userId}/`)) throw new HttpError(400, 'INVALID_PROOF', 'Capture invalide.');
  await supabase.from('match_captures').update({ proof_path: path }).eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo).eq('submitted_by', userId).is('proof_path', null);
  return matchStats(kind, id, userId);
}

const matchUrl = (kind: MatchKind, id: string) => `${config.siteUrl}/${kind === 'classe' ? 'cod/match' : 'cod/equipes/match'}/${id}`;
const usernameOf = async (id: string) => ((await supabase.from('users').select('username').eq('id', id).maybeSingle()).data as { username: string } | null)?.username ?? 'Joueur';

/** Un joueur du match signale une ligne : l'équipe voit la capture à côté des chiffres. Un signalement par ligne. */
export async function reportStats(kind: MatchKind, id: string, userId: string, body: unknown) {
  const info = await matchInfo(kind, id);
  if (![...info.sides[0], ...info.sides[1]].includes(userId)) throw new HttpError(403, 'NOT_IN_MATCH', 'Seuls les joueurs du match peuvent signaler.');
  const input = (body ?? {}) as { mapNo?: unknown; userId?: unknown };
  const mapNo = Number(input.mapNo);
  const line = (await mapRows(kind, id, mapNo)).find((row) => row.userId === input.userId);
  if (!line) throw new HttpError(400, 'INVALID_STATS', 'Choisis la map et le joueur concernés.');
  const { data } = await supabase.rpc('app_claim', { p_key: `stats_report_${kind}_${id}_${mapNo}_${line.userId}`, p_value: '1' });
  if (data) await notifyStaff(`📊 Stats signalées par ${await usernameOf(userId)} : map ${mapNo}, ligne de ${await usernameOf(line.userId)} (${line.score} pts, ${line.kills} élim.) : ${matchUrl(kind, id)}`);
  return { reported: true };
}

/** Un arbitre corrige une ligne en regardant la capture. */
export async function correctStats(kind: MatchKind, id: string, mapNo: number, targetId: string, userId: string, body: unknown) {
  if (!MATCH_REFEREES.includes(await roleOf(userId))) throw new HttpError(403, 'FORBIDDEN', 'Réservé à l’équipe.');
  const info = await matchInfo(kind, id);
  const input = (body ?? {}) as Partial<StatRow>;
  if (!validRow(input)) throw new HttpError(400, 'INVALID_STATS', 'Chiffres invalides : le score est un multiple de 5.');
  const { score, kills, plants, defuses } = input as StatRow;
  const rows = await mapRows(kind, id, mapNo);
  const previous = rows.find((row) => row.userId === targetId);
  if (!previous) throw new HttpError(404, 'STATS_NOT_FOUND', 'Ligne introuvable.');
  const next = rows.map((row) => (row.userId === targetId ? { userId: targetId, score, kills, plants, defuses } : row));
  if (!plausibleRows(next, info.sides, info.roundsToWin)) throw new HttpError(400, 'IMPOSSIBLE_STATS', 'Ces chiffres sont impossibles pour ce match.');
  unwrap(await supabase.from('match_player_stats').update({ score, kills, plants, defuses, submitted_by: userId }).eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo).eq('user_id', targetId).select('user_id'));
  updateCardSoon(kind, id);
  logToDiscord(`📊 ${await usernameOf(userId)} a corrigé les stats de ${await usernameOf(targetId)} (map ${mapNo}) : ${previous.score} pts, ${previous.kills} élim. → ${score} pts, ${kills} élim. ${matchUrl(kind, id)}`);
  return matchStats(kind, id, userId);
}

/** Un arbitre retire la capture d'une map : une autre peut être envoyée. */
export async function removeStats(kind: MatchKind, id: string, mapNo: number, userId: string) {
  if (!MATCH_REFEREES.includes(await roleOf(userId))) throw new HttpError(403, 'FORBIDDEN', 'Réservé à l’équipe.');
  unwrap(await supabase.from('match_player_stats').delete().eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo).select('user_id'));
  await supabase.from('match_captures').delete().eq('match_kind', kind).eq('match_id', id).eq('map_no', mapNo);
  updateCardSoon(kind, id);
  return matchStats(kind, id, userId);
}

/** Garde les lignes des matchs terminés : un match annulé ou amical ne compte pas. */
async function countedRows<Row extends { match_kind: MatchKind; match_id: string }>(rows: Row[]): Promise<Row[]> {
  const finished = async (kind: MatchKind, table: string, filter: Record<string, unknown>) => {
    const ids = [...new Set(rows.filter((row) => row.match_kind === kind).map((row) => row.match_id))];
    const done = new Set<string>();
    for (let index = 0; index < ids.length; index += 100) {
      const { data: found } = await supabase.from(table).select('id').in('id', ids.slice(index, index + 100)).match(filter);
      for (const row of (found ?? []) as { id: string }[]) done.add(row.id);
    }
    return done;
  };
  const [ranked, division] = await Promise.all([finished('classe', 'cod_matches', { status: 'completed' }), finished('division', 'team_matches', { status: 'completed', friendly: false })]);
  return rows.filter((row) => (row.match_kind === 'classe' ? ranked : division).has(row.match_id));
}

/**
 * Records de la Renommée : plus d'élim. et plus gros score sur une map, de tous les temps. À égalité, le premier à l'avoir fait.
 * Quelques lignes de réserve, car les meilleures peuvent venir d'un match annulé.
 */
export async function mapRecords() {
  const best = async (column: 'kills' | 'score') => {
    const { data } = await supabase.from('match_player_stats').select('match_kind, match_id, user_id, kills, score').gt(column, 0).order(column, { ascending: false }).order('created_at').limit(50);
    const [first] = await countedRows((data ?? []) as { match_kind: MatchKind; match_id: string; user_id: string; kills: number; score: number }[]);
    return first ? { userId: first.user_id, value: first[column], matchPath: `/${first.match_kind === 'classe' ? 'cod/match' : 'cod/equipes/match'}/${first.match_id}` } : null;
  };
  const [kills, score] = await Promise.all([best('kills'), best('score')]);
  return { kills, score };
}

/** Record de la Renommée : poses + désamorçages par map depuis le début de la saison, tous modes confondus. */
export async function seasonObjectiveLeader() {
  const { data: season } = await supabase.from('seasons').select('starts_at').eq('is_active', true).maybeSingle();
  const start = (season as { starts_at: string } | null)?.starts_at;
  if (!start) return null;
  const { data } = await supabase.from('match_player_stats').select('match_kind, match_id, user_id, plants, defuses').gte('created_at', start).limit(10000);
  return objectiveLeader(await countedRows((data ?? []) as { match_kind: MatchKind; match_id: string; user_id: string; plants: number; defuses: number }[]));
}

const playerCard = async (id: string) => {
  const { data } = await supabase.from('users').select('id, username, avatar_url').eq('id', id).maybeSingle();
  const user = data as { id: string; username: string; avatar_url: string | null } | null;
  return { id, username: user?.username ?? 'Joueur', avatarUrl: user?.avatar_url ?? null };
};

/** Meilleur joueur d'une coupe, d'après les captures de ses matchs terminés. Null sans capture. */
export async function cupBestPlayer(tournamentId: string) {
  const { data: matches } = await supabase.from('team_matches').select('id').eq('tournament_id', tournamentId);
  const ids = ((matches ?? []) as { id: string }[]).map((match) => match.id);
  if (ids.length === 0) return null;
  const { data } = await supabase.from('match_player_stats').select('match_kind, match_id, user_id, score, kills, plants, defuses').eq('match_kind', 'division').in('match_id', ids);
  const best = cupBest(await countedRows((data ?? []) as (SeasonStatLine & { match_kind: MatchKind; match_id: string; user_id: string })[]));
  return best ? { ...best, ...(await playerCard(best.userId)) } : null;
}

let boardCache: { at: number; data: unknown } | null = null;

/** Classements de stats de la saison (GET /cod/stats-leaderboard), tous modes confondus : gardés une minute en mémoire. */
export async function statsLeaderboard() {
  if (boardCache && Date.now() - boardCache.at < 60_000) return boardCache.data;
  const { data: season } = await supabase.from('seasons').select('starts_at').eq('is_active', true).maybeSingle();
  const start = (season as { starts_at: string } | null)?.starts_at;
  const { data } = start ? await supabase.from('match_player_stats').select('match_kind, match_id, user_id, score, kills, plants, defuses').gte('created_at', start).limit(10000) : { data: [] };
  const board = statsBoard(await countedRows((data ?? []) as (SeasonStatLine & { match_kind: MatchKind; match_id: string; user_id: string })[]));
  const ids = board.map((row) => row.userId);
  const { data: users } = ids.length ? await supabase.from('users').select('id, username, avatar_url').in('id', ids) : { data: [] };
  const names = new Map(((users ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((user) => [user.id, user]));
  const players = board.map(({ userId, ...row }) => ({ ...row, id: userId, username: names.get(userId)?.username ?? 'Joueur', avatarUrl: names.get(userId)?.avatar_url ?? null }));
  const result = { minMaps: OBJECTIVE_MIN_MAPS, players };
  boardCache = { at: Date.now(), data: result };
  return result;
}

/** Bilan d'un joueur sur la saison en cours (profil), chiffres de chaque match pour l'historique : les matchs annulés ne comptent pas. */
export async function playerStats(userId: string) {
  const { data: season } = await supabase.from('seasons').select('starts_at').eq('is_active', true).maybeSingle();
  const start = (season as { starts_at: string } | null)?.starts_at;
  const { data } = await supabase.from('match_player_stats').select('match_kind, match_id, score, kills, plants, defuses, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(2000);
  const rows = (data ?? []) as (SeasonStatLine & { match_kind: MatchKind; match_id: string; created_at: string })[];
  const counted = await countedRows(rows);
  return { ...summarizeStats(counted.filter((row) => !start || row.created_at >= start)), matches: statsByMatch(counted) };
}

/**
 * Rappel sur le site (GET /cod/capture-reminder) : le dernier match terminé du joueur, depuis moins de 24 h, s'il lui
 * manque une capture (ni forfait ni amical). Le site retient les rappels fermés, un seul par match.
 */
export async function captureReminder(userId: string, now = Date.now()) {
  const since = new Date(now - STATS_WINDOW_MS).toISOString();
  const [ranked, division] = await Promise.all([
    supabase.from('cod_matches').select('id, team_a, team_b, completed_at').eq('status', 'completed').gte('completed_at', since).or(`team_a.cs.{${userId}},team_b.cs.{${userId}}`).order('completed_at', { ascending: false }).limit(1),
    supabase.from('team_matches').select('id, roster_a, roster_b, scores, completed_at').eq('status', 'completed').eq('forfeit', false).eq('friendly', false).gte('completed_at', since).or(`roster_a.cs.{${userId}},roster_b.cs.{${userId}}`).order('completed_at', { ascending: false }).limit(1),
  ]);
  const matches = [
    ...((ranked.data ?? []) as { id: string; team_a: string[]; team_b: string[]; completed_at: string }[]).map((match) => ({ kind: 'classe' as const, id: match.id, players: match.team_a.length + match.team_b.length, maps: 1, at: match.completed_at })),
    ...((division.data ?? []) as { id: string; roster_a: string[]; roster_b: string[]; scores: unknown[] | null; completed_at: string }[]).map((match) => ({ kind: 'division' as const, id: match.id, players: match.roster_a.length + match.roster_b.length, maps: Math.max(1, match.scores?.length ?? 1), at: match.completed_at })),
  ];
  const last = matches.sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!last) return null;
  const { data } = await supabase.from('match_player_stats').select('map_no').eq('match_kind', last.kind).eq('match_id', last.id);
  const open = openMaps(last.maps, (data ?? []) as { map_no: number }[], last.players);
  return open.length ? { kind: last.kind, id: last.id, text: captureReminderText(open, last.maps) } : null;
}
