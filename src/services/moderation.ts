import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';

/**
 * Vote du MVP, demandes d'arbitrage et signalements de joueurs.
 *
 *   - MVP : chaque joueur d'un match terminé élit le meilleur joueur (24 h pour voter).
 *     Le plus élu du mois écoulé reçoit le badge « mvp-AAAA-MM » (cod_award_monthly_mvp).
 *   - Arbitrage : pendant un match, un joueur demande l'intervention d'un admin.
 *   - Signalement : n'importe quel joueur connecté peut signaler un autre joueur.
 * Arbitrages et signalements sont privés (lus par les admins uniquement).
 */

export const ARBITRATION_REASONS: Record<string, string> = {
  cheating: 'Triche suspectée',
  afk: 'Joueur absent ou AFK',
  lobby: 'Problème de partie (hôte, lobby, déconnexion)',
  score: 'Désaccord sur le score',
  behavior: 'Comportement toxique',
  other: 'Autre',
};

export const REPORT_REASONS: Record<string, string> = {
  cheating: 'Triche',
  toxicity: 'Insultes ou comportement toxique',
  afk: 'Abandon ou AFK',
  smurf: 'Compte multiple',
  name: 'Pseudo ou avatar inapproprié',
  other: 'Autre',
};

function cleanDetails(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 500) {
    throw new HttpError(400, 'INVALID_DETAILS', 'La description doit faire 500 caractères au plus.');
  }
  return value.trim() || null;
}

/** Pseudo d'un joueur (pour les messages à l'équipe). */
export async function usernameOf(userId: string): Promise<string> {
  const { data } = await supabase.from('users').select('username').eq('id', userId).maybeSingle();
  return (data as { username?: string } | null)?.username ?? 'un joueur';
}

// --- MVP --------------------------------------------------------------------------

export async function voteMvp(matchId: string, voterId: string, targetId: unknown): Promise<void> {
  if (typeof targetId !== 'string') throw new HttpError(400, 'INVALID_MVP', 'Joueur invalide.');
  unwrap(await supabase.rpc('cod_vote_mvp', { p_match: matchId, p_voter: voterId, p_target: targetId }));
}

/**
 * Votes d'un match : total par joueur, et votes reçus des autres joueurs (hors vote
 * pour soi), qui départagent une égalité. Toujours à égalité : co-MVP.
 */
export async function mvpVotesOf(matchId: string): Promise<{ total: Record<string, number>; fromOthers: Record<string, number> }> {
  const rows = (unwrap(await supabase.from('cod_mvp_votes').select('voter_id, target_id').eq('match_id', matchId)) ?? []) as {
    voter_id: string;
    target_id: string;
  }[];
  const total: Record<string, number> = {};
  const fromOthers: Record<string, number> = {};
  for (const row of rows) {
    total[row.target_id] = (total[row.target_id] ?? 0) + 1;
    if (row.voter_id !== row.target_id) fromOthers[row.target_id] = (fromOthers[row.target_id] ?? 0) + 1;
  }
  return { total, fromOthers };
}

/**
 * Attribue le MVP du mois précédent s'il ne l'a pas encore été (appelé au démarrage
 * puis toutes les heures). Renvoie le gagnant nouvellement connu, ou null.
 */
export async function awardPreviousMonthMvp(): Promise<{ userId: string; month: string } | null> {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = previous.toISOString().slice(0, 10);
  const existing = unwrap(await supabase.from('cod_monthly_mvp').select('user_id').eq('month', month).maybeSingle());
  if (existing) return null;
  const winner = unwrap(await supabase.rpc('cod_award_monthly_mvp', { p_month: month })) as string | null;
  return winner ? { userId: winner, month } : null;
}

// --- Arbitrage ----------------------------------------------------------------------

export interface ArbitrationRequest {
  id: number;
  match_id: string;
  user_id: string;
  reason: string;
  details: string | null;
  status: 'open' | 'resolved' | 'rejected';
  resolution: string | null;
  created_at: string;
}

export async function requestArbitration(matchId: string, userId: string, body: unknown): Promise<ArbitrationRequest> {
  const input = (body ?? {}) as { reason?: unknown; details?: unknown };
  if (typeof input.reason !== 'string' || !ARBITRATION_REASONS[input.reason]) {
    throw new HttpError(400, 'INVALID_REASON', 'Choisis un motif.');
  }
  const details = cleanDetails(input.details);

  const match = unwrap(await supabase.from('cod_matches').select('status, team_a, team_b').eq('id', matchId).maybeSingle()) as {
    status: string;
    team_a: string[];
    team_b: string[];
  } | null;
  if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
  if (![...match.team_a, ...match.team_b].includes(userId)) throw new HttpError(403, 'NOT_A_PLAYER', 'Tu ne participes pas à ce match.');
  if (!['in_progress', 'awaiting_confirmation', 'disputed'].includes(match.status)) {
    throw new HttpError(409, 'MATCH_CLOSED', "Ce match est terminé : utilise plutôt « Signaler » sur le joueur concerné.");
  }

  const { count, error } = await supabase
    .from('cod_arbitration_requests')
    .select('id', { count: 'exact', head: true })
    .eq('match_id', matchId)
    .eq('user_id', userId)
    .eq('status', 'open');
  if (error) throw fromDbError(error);
  if ((count ?? 0) >= 2) throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Tu as déjà deux demandes en attente pour ce match : un admin arrive.');

  return unwrap(
    await supabase.from('cod_arbitration_requests').insert({ match_id: matchId, user_id: userId, reason: input.reason, details }).select('*').single(),
  ) as ArbitrationRequest;
}

export async function myArbitrations(matchId: string, userId: string): Promise<ArbitrationRequest[]> {
  return (unwrap(
    await supabase.from('cod_arbitration_requests').select('*').eq('match_id', matchId).eq('user_id', userId).order('created_at'),
  ) ?? []) as ArbitrationRequest[];
}

// --- Signalements -------------------------------------------------------------------

export interface PlayerReport {
  id: number;
  reporter_id: string;
  target_id: string;
  match_id: string | null;
  reason: string;
  details: string | null;
  status: 'open' | 'resolved' | 'rejected';
  created_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function reportPlayer(reporterId: string, body: unknown): Promise<PlayerReport> {
  const input = (body ?? {}) as { targetId?: unknown; matchId?: unknown; reason?: unknown; details?: unknown };
  if (typeof input.targetId !== 'string' || !UUID.test(input.targetId)) throw new HttpError(400, 'INVALID_TARGET', 'Joueur invalide.');
  if (input.targetId === reporterId) throw new HttpError(400, 'INVALID_TARGET', 'Tu ne peux pas te signaler toi-même.');
  if (typeof input.reason !== 'string' || !REPORT_REASONS[input.reason]) throw new HttpError(400, 'INVALID_REASON', 'Choisis un motif.');
  const matchId = typeof input.matchId === 'string' && UUID.test(input.matchId) ? input.matchId : null;
  const details = cleanDetails(input.details);

  const target = unwrap(await supabase.from('users').select('id').eq('id', input.targetId).maybeSingle());
  if (!target) throw new HttpError(404, 'PLAYER_NOT_FOUND', 'Joueur introuvable.');

  // Un même signalement n'est compté qu'une fois, et pas plus de 10 par jour et par joueur.
  let duplicate = supabase
    .from('cod_player_reports')
    .select('id', { count: 'exact', head: true })
    .eq('reporter_id', reporterId)
    .eq('target_id', input.targetId)
    .eq('status', 'open');
  duplicate = matchId ? duplicate.eq('match_id', matchId) : duplicate.is('match_id', null);
  const [dup, today] = await Promise.all([
    duplicate,
    supabase
      .from('cod_player_reports')
      .select('id', { count: 'exact', head: true })
      .eq('reporter_id', reporterId)
      .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
  ]);
  if (dup.error) throw fromDbError(dup.error);
  if (today.error) throw fromDbError(today.error);
  if ((dup.count ?? 0) > 0) throw new HttpError(409, 'ALREADY_REPORTED', 'Tu as déjà signalé ce joueur : un admin va examiner ton signalement.');
  if ((today.count ?? 0) >= 10) throw new HttpError(429, 'TOO_MANY_REPORTS', 'Trop de signalements aujourd’hui. Réessaie demain.');

  return unwrap(
    await supabase
      .from('cod_player_reports')
      .insert({ reporter_id: reporterId, target_id: input.targetId, match_id: matchId, reason: input.reason, details })
      .select('*')
      .single(),
  ) as PlayerReport;
}

// --- Administration -------------------------------------------------------------------

type Table = 'cod_arbitration_requests' | 'cod_player_reports';

/** Liste pour l'administration, avec les pseudos (ouverts d'abord). */
export async function listForAdmin(table: Table, status: unknown) {
  let query = supabase.from(table).select('*').order('created_at', { ascending: false }).limit(100);
  if (status === 'open' || status === 'resolved' || status === 'rejected') query = query.eq('status', status);
  const rows = (unwrap(await query) ?? []) as Record<string, unknown>[];
  const ids = new Set<string>();
  for (const row of rows) {
    for (const key of ['user_id', 'reporter_id', 'target_id', 'resolved_by']) {
      if (typeof row[key] === 'string') ids.add(row[key] as string);
    }
  }
  const names = new Map<string, string>();
  if (ids.size > 0) {
    const users = (unwrap(await supabase.from('users').select('id, username').in('id', [...ids])) ?? []) as { id: string; username: string }[];
    for (const user of users) names.set(user.id, user.username);
  }
  const labels = table === 'cod_arbitration_requests' ? ARBITRATION_REASONS : REPORT_REASONS;
  return rows.map((row) => ({
    ...row,
    reason_label: labels[row.reason as string] ?? row.reason,
    user_name: typeof row.user_id === 'string' ? names.get(row.user_id) ?? null : undefined,
    reporter_name: typeof row.reporter_id === 'string' ? names.get(row.reporter_id) ?? null : undefined,
    target_name: typeof row.target_id === 'string' ? names.get(row.target_id) ?? null : undefined,
    resolved_by_name: typeof row.resolved_by === 'string' ? names.get(row.resolved_by) ?? null : null,
  }));
}

export async function closeCase(table: Table, id: unknown, adminId: string, body: unknown) {
  const caseId = Number(id);
  if (!Number.isInteger(caseId) || caseId < 1) throw new HttpError(400, 'INVALID_ID', 'Identifiant invalide.');
  const input = (body ?? {}) as { status?: unknown; resolution?: unknown };
  if (input.status !== 'resolved' && input.status !== 'rejected' && input.status !== 'open') {
    throw new HttpError(400, 'INVALID_STATUS', 'Statut invalide.');
  }
  const resolution = cleanDetails(input.resolution);
  const reopened = input.status === 'open';
  const row = unwrap(
    await supabase
      .from(table)
      .update({
        status: input.status,
        resolution: reopened ? null : resolution,
        resolved_by: reopened ? null : adminId,
        resolved_at: reopened ? null : new Date().toISOString(),
      })
      .eq('id', caseId)
      .select('*')
      .maybeSingle(),
  );
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Élément introuvable.');
  return row;
}

/** Nombre de demandes d'arbitrage et de signalements en attente (tableau de bord). */
export async function openCounts(): Promise<{ arbitrations: number; reports: number }> {
  const [arbitrations, reports] = await Promise.all([
    supabase.from('cod_arbitration_requests').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('cod_player_reports').select('id', { count: 'exact', head: true }).eq('status', 'open'),
  ]);
  return { arbitrations: arbitrations.count ?? 0, reports: reports.count ?? 0 };
}
