import { config } from '../config.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { dm } from './discord.js';
import { leaveQueue } from './queue.js';

/**
 * Sanctions manuelles données par l'admin ou le staff (fonctions SQL cod_apply_sanction
 * et cod_lift_sanction, migration 0017). Le joueur est prévenu en message privé Discord.
 *
 *   warning   avertissement (historique)
 *   temp_ban  exclusion temporaire de la file classée (minutes)
 *   perm_ban  exclusion définitive du classé, jusqu'à levée
 *   points    retrait de points (les points réellement retirés sont rendus à la levée)
 */

export const SANCTION_TYPES = ['warning', 'temp_ban', 'perm_ban', 'points'] as const;
export type SanctionType = (typeof SANCTION_TYPES)[number];

export const SANCTION_LABELS: Record<SanctionType, string> = {
  warning: 'Avertissement',
  temp_ban: 'Exclusion temporaire de la file',
  perm_ban: 'Exclusion définitive du classé',
  points: 'Retrait de points',
};

export interface Sanction {
  id: number;
  user_id: string;
  type: SanctionType;
  reason: string;
  minutes: number | null;
  points: number | null;
  ends_at: string | null;
  report_id: number | null;
  created_by: string | null;
  created_at: string;
  lifted_at: string | null;
  lifted_by: string | null;
  lift_reason: string | null;
}

/** « 2 h », « 3 j », « 45 min ». */
export function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} j`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function describe(sanction: Sanction): string {
  if (sanction.type === 'temp_ban' && sanction.minutes) return `${SANCTION_LABELS.temp_ban} (${formatMinutes(sanction.minutes)})`;
  if (sanction.type === 'points') return `${SANCTION_LABELS.points} (-${sanction.points ?? 0} pts)`;
  return SANCTION_LABELS[sanction.type];
}

/** Valide la saisie du formulaire de sanction. */
export function parseSanction(body: unknown): { type: SanctionType; reason: string; minutes: number | null; points: number | null; reportId: number | null } {
  const input = (body ?? {}) as Record<string, unknown>;
  const type = input.type as SanctionType;
  if (!SANCTION_TYPES.includes(type)) throw new HttpError(400, 'INVALID_SANCTION', 'Type de sanction inconnu.');
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (!reason) throw new HttpError(400, 'INVALID_REASON', 'Indique un motif (500 caractères au plus).');
  const minutes = type === 'temp_ban' ? Number(input.minutes) : null;
  const points = type === 'points' ? Number(input.points) : null;
  const reportId = input.reportId === undefined || input.reportId === null ? null : Number(input.reportId);
  if (reportId !== null && (!Number.isInteger(reportId) || reportId < 1)) throw new HttpError(400, 'INVALID_ID', 'Signalement invalide.');
  return { type, reason, minutes, points, reportId };
}

/** Historique des sanctions d'un joueur, avec les pseudos de l'équipe. */
export async function listSanctions(userId: string) {
  const rows = (unwrap(
    await supabase.from('cod_sanctions').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50),
  ) ?? []) as Sanction[];
  const ids = [...new Set(rows.flatMap((row) => [row.created_by, row.lifted_by]).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const users = (unwrap(await supabase.from('users').select('id, username').in('id', ids)) ?? []) as { id: string; username: string }[];
    for (const user of users) names.set(user.id, user.username);
  }
  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    label: describe(row),
    active: !row.lifted_at && (row.type === 'warning' || row.type === 'points' || (row.ends_at !== null && new Date(row.ends_at).getTime() > now)),
    created_by_name: row.created_by ? names.get(row.created_by) ?? null : null,
    lifted_by_name: row.lifted_by ? names.get(row.lifted_by) ?? null : null,
  }));
}

/** Applique une sanction, retire le joueur de la file s'il est exclu, clôt le signalement lié et le prévient. */
export async function applySanction(userId: string, body: unknown, staffId: string): Promise<Sanction> {
  const input = parseSanction(body);
  const sanction = unwrap(
    await supabase.rpc('cod_apply_sanction', {
      p_user: userId,
      p_type: input.type,
      p_reason: input.reason,
      p_minutes: input.minutes,
      p_points: input.points,
      p_by: staffId,
      p_report: input.reportId,
    }),
  ) as Sanction;

  if (sanction.type === 'temp_ban' || sanction.type === 'perm_ban') {
    await leaveQueue(userId, "Un membre du groupe a été exclu de la file : recherche annulée.").catch(() => []);
  }
  if (input.reportId) {
    await supabase
      .from('cod_player_reports')
      .update({ status: 'resolved', resolution: `Sanction : ${describe(sanction)}. ${input.reason}`.slice(0, 500), resolved_by: staffId, resolved_at: new Date().toISOString() })
      .eq('id', input.reportId);
  }

  const until =
    sanction.type === 'temp_ban' && sanction.ends_at
      ? `\nFin : ${new Date(sanction.ends_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`
      : '';
  void dm(
    [userId],
    `**Sanction SixSence** — ${describe(sanction)}\nMotif : ${input.reason}${until}\nTu peux contester cette décision auprès de l'équipe sur Discord. Règlement : ${config.siteUrl}/reglement`,
  );
  return sanction;
}

/** Lève une sanction (exclusion recalculée, points rendus) et prévient le joueur. */
export async function liftSanction(id: unknown, staffId: string, body: unknown): Promise<Sanction> {
  const sanctionId = Number(id);
  if (!Number.isInteger(sanctionId) || sanctionId < 1) throw new HttpError(400, 'INVALID_ID', 'Identifiant invalide.');
  const reason = typeof (body as { reason?: unknown } | undefined)?.reason === 'string' ? ((body as { reason: string }).reason.trim().slice(0, 500) || null) : null;
  const sanction = unwrap(await supabase.rpc('cod_lift_sanction', { p_id: sanctionId, p_by: staffId, p_reason: reason })) as Sanction;
  void dm([sanction.user_id], `**SixSence** — Ta sanction « ${describe(sanction)} » a été levée.${reason ? `\nMotif : ${reason}` : ''}`);
  return sanction;
}
