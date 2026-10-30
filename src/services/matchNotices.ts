import { config } from '../config.js';
import type { CodMatch } from '../events.js';
import { supabase } from '../supabase.js';
import { dm, notifyStaff } from './discord.js';
import { pushToUsers } from './push.js';
import { waitedFor } from './waitPolicy.js';

/**
 * Notifications de la vie d'un match (notification push + message privé Discord) :
 *   - résultat déclaré : l'équipe adverse doit confirmer ou contester ;
 *   - résultat contesté : salon de l'équipe SixSence et équipe qui a déclaré ;
 *   - décision de l'équipe (vainqueur ou annulation) : tous les joueurs ;
 *   - match non accepté : avertissement ou exclusion du joueur absent ;
 *   - fin du match : points gagnés ou perdus de chaque joueur ;
 *   - match abandonné (aucun résultat déclaré à temps) : tous les joueurs ;
 *   - résultat corrigé par l'équipe (match terminé) : tous les joueurs et salon de l'équipe ;
 *   - relance de l'équipe pour ce qui attend depuis plus de 2 h.
 * Tout est « au mieux » : une erreur n'empêche jamais le match de se dérouler.
 */

const matchUrl = (match: CodMatch) => `${config.siteUrl}/cod/match/${match.id}`;
const teamLabel = (team: 'A' | 'B') => (team === 'A' ? 'Équipe 1' : 'Équipe 2');
const players = (match: CodMatch) => [...match.team_a, ...match.team_b];
const title = (match: CodMatch) => `${match.format ?? `${match.team_size}v${match.team_size}`} · ${match.map}`;
const hour = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

async function usernameOf(userId: string | null): Promise<string> {
  if (!userId) return 'Un joueur';
  const { data } = await supabase.from('users').select('username').eq('id', userId).maybeSingle();
  return (data as { username?: string } | null)?.username ?? 'Un joueur';
}

/** Un joueur a déclaré le vainqueur : l'équipe adverse a quelques minutes pour répondre. */
export async function noticeResultReported(match: CodMatch): Promise<void> {
  if (!match.reported_by || !match.reported_winner) return;
  const opponents = match.team_a.includes(match.reported_by) ? match.team_b : match.team_a;
  const name = await usernameOf(match.reported_by);
  const minutes = config.cod.confirmMinutes;
  const text = `${name} déclare la victoire de l'${teamLabel(match.reported_winner)}. Confirme ou conteste dans les ${minutes} min, sinon le résultat sera validé.`;
  await Promise.all([
    pushToUsers(opponents, { title: 'Résultat déclaré', body: text, url: `/cod/match/${match.id}`, tag: `match-${match.id}`, urgent: true }),
    dm(opponents, `**Résultat déclaré** — ${title(match)}\n${text}\n${matchUrl(match)}`),
  ]);
}

/** Résultat contesté : l'équipe SixSence est prévenue, l'équipe qui a déclaré aussi. */
export async function noticeResultDisputed(match: CodMatch, contesterId: string): Promise<void> {
  const reporters = match.reported_by && match.team_a.includes(match.reported_by) ? match.team_a : match.team_b;
  const name = await usernameOf(contesterId);
  await Promise.all([
    notifyStaff(
      `⚖️ **Match contesté** — ${title(match)}\n` +
        `${await usernameOf(match.reported_by)} a déclaré la victoire de l'${teamLabel(match.reported_winner ?? 'A')}, ${name} conteste.\n` +
        `${matchUrl(match)} · ${config.siteUrl}/admin?onglet=disputes`,
    ),
    pushToUsers(reporters, {
      title: 'Résultat contesté',
      body: `${name} conteste le résultat. Un arbitre SixSence va trancher : aucun point ne bouge d'ici là.`,
      url: `/cod/match/${match.id}`,
      tag: `match-${match.id}`,
    }),
  ]);
}

/** Décision de l'équipe SixSence sur un match (vainqueur désigné ou match annulé). */
export async function noticeMatchResolved(match: CodMatch): Promise<void> {
  if (match.status === 'cancelled') {
    const text = "Le match a été annulé par l'équipe SixSence : aucun point ne bouge.";
    await Promise.all([
      pushToUsers(players(match), { title: 'Match annulé', body: text, url: `/cod/match/${match.id}`, tag: `match-${match.id}` }),
      dm(players(match), `**Décision de l'équipe SixSence** — ${title(match)}\n${text}\n${matchUrl(match)}`),
    ]);
    return;
  }
  if (match.status !== 'completed' || !match.winner) return;
  // Les points arrivent juste après par la notification de fin de match : ici, message Discord seulement.
  await dm(players(match), `**Décision de l'équipe SixSence** — ${title(match)}\nVictoire attribuée à l'${teamLabel(match.winner)}.\n${matchUrl(match)}`);
}

/** Match non accepté à temps : le joueur absent sait ce que ça lui coûte. */
export async function noticeMatchMissed(userId: string, bannedUntil: string | null): Promise<void> {
  const banned = bannedUntil && new Date(bannedUntil).getTime() > Date.now();
  const text = banned
    ? new Date(bannedUntil).getUTCFullYear() >= 9000
      ? "Tu n'as pas accepté le match : il est annulé."
      : `Tu n'as pas accepté le match : il est annulé et tu es exclu de la file jusqu'à ${hour(bannedUntil)}.`
    : "Tu n'as pas accepté le match : il est annulé. Avertissement : au prochain oubli dans les 24 h, tu seras exclu 15 min.";
  await Promise.all([
    pushToUsers([userId], { title: 'Match annulé', body: text, url: '/cod/ranked', tag: 'file' }),
    dm([userId], `**Match annulé** — ${text}\nRèglement : ${config.siteUrl}/reglement`),
  ]);
}

/** Match annulé faute de résultat déclaré à temps. */
export async function noticeMatchAbandoned(match: CodMatch): Promise<void> {
  const hours = Math.round(config.cod.cancelMinutes / 60);
  const text = `Aucun résultat n'a été déclaré dans les ${hours} h : le match est annulé, aucun point ne bouge.`;
  await Promise.all([
    pushToUsers(players(match), { title: 'Match annulé', body: text, url: `/cod/match/${match.id}`, tag: `match-${match.id}` }),
    dm(players(match), `**Match annulé** — ${title(match)}\n${text}\n${matchUrl(match)}`),
  ]);
}

/**
 * Résultat corrigé après validation (mauvais clic…) : tous les joueurs sont prévenus, et le salon de
 * l'équipe garde une trace. Pour une inversion, les nouveaux points arrivent par la notification de fin
 * de match (le match est revalidé).
 */
export async function noticeMatchCorrected(match: CodMatch, staffId: string): Promise<void> {
  const staff = await usernameOf(staffId);
  const reason = match.correction_reason ?? '';
  const decision =
    match.correction_action === 'cancel'
      ? 'Le match est annulé : les points, victoires et défaites du match sont rendus.'
      : `Victoire attribuée à l'${teamLabel(match.winner ?? 'A')} : les points sont recalculés.`;
  const motif = reason ? `\nMotif : ${reason}` : '';
  await Promise.all([
    match.correction_action === 'cancel'
      ? pushToUsers(players(match), { title: 'Résultat corrigé', body: `${title(match)} · match annulé, points rendus`, url: `/cod/match/${match.id}`, tag: `match-${match.id}` })
      : Promise.resolve(),
    dm(players(match), `🛡️ **Résultat corrigé par l'équipe SixSence** — ${title(match)}\n${decision}${motif}\n${matchUrl(match)}`),
    notifyStaff(`🛠️ **Match corrigé** par ${staff} — ${title(match)}\n${decision}${motif}\n${matchUrl(match)}`),
  ]);
}

/** Fin du match : chaque joueur reçoit son résultat, ses points et son nouveau total. */
export async function noticeMatchFinished(match: CodMatch): Promise<void> {
  if (match.status !== 'completed' || !match.winner) return;
  const winners = new Set(match.winner === 'A' ? match.team_a : match.team_b);
  const { data } = await supabase.from('cod_profiles').select('user_id, points').in('user_id', players(match));
  const totals = new Map(((data ?? []) as { user_id: string; points: number }[]).map((row) => [row.user_id, row.points]));
  await Promise.all(
    players(match).map((userId) => {
      const change = match.points_changes?.[userId] ?? 0;
      const total = totals.get(userId);
      return pushToUsers([userId], {
        title: winners.has(userId) ? '🏆 Victoire' : 'Défaite',
        body: `${title(match)} · ${change >= 0 ? '+' : '−'}${Math.abs(change)} pts${total !== undefined ? ` · ${total.toLocaleString('fr-FR')} pts au total` : ''}`,
        url: `/cod/match/${match.id}`,
        tag: `resultat-${match.id}`,
      });
    }),
  );
}

const REMINDER_HOURS = 2;

/**
 * Relance de l'équipe : contestations (classé, Division et coupes), demandes d'arbitrage et signalements en attente
 * depuis plus de 2 h, avec la vraie durée d'attente du plus ancien de chaque liste. Un seul message toutes les 2 h au
 * plus (app_claim), et rien s'il n'y a rien.
 */
export async function remindStaff(now = Date.now()): Promise<void> {
  const before = new Date(now - REMINDER_HOURS * 60 * 60_000).toISOString();
  // Éléments en attente depuis plus de 2 h, du plus ancien au plus récent : nombre et date du plus ancien.
  const waiting = async (query: PromiseLike<{ data: unknown }>, column: string) => {
    const rows = ((await query).data ?? []) as Record<string, string>[];
    return { count: rows.length, oldest: rows[0]?.[column] ?? null };
  };
  const [disputes, teamDisputes, arbitrations, reports] = await Promise.all([
    waiting(supabase.from('cod_matches').select('reported_at').eq('status', 'disputed').lt('reported_at', before).order('reported_at').limit(100), 'reported_at'),
    waiting(supabase.from('team_matches').select('updated_at').eq('status', 'disputed').lt('updated_at', before).order('updated_at').limit(100), 'updated_at'),
    waiting(supabase.from('cod_arbitration_requests').select('created_at').eq('status', 'open').lt('created_at', before).order('created_at').limit(100), 'created_at'),
    waiting(supabase.from('cod_player_reports').select('created_at').eq('status', 'open').lt('created_at', before).order('created_at').limit(100), 'created_at'),
  ]);
  if (disputes.count + teamDisputes.count + arbitrations.count + reports.count === 0) return;
  const slot = String(Math.floor(now / (REMINDER_HOURS * 60 * 60_000)));
  const { data: claimed } = await supabase.rpc('app_claim', { p_key: 'staff_reminder', p_value: slot });
  if (!claimed) return;
  const line = (item: { count: number; oldest: string | null }, one: string, many: string, link: string) =>
    item.count
      ? `${item.count} ${item.count > 1 ? many : one}, ${item.count > 1 ? 'la plus ancienne ' : ''}en attente depuis ${waitedFor(now - Date.parse(item.oldest!))} (${config.siteUrl}${link})`
      : '';
  const parts = [
    line(disputes, 'contestation en Classé', 'contestations en Classé', '/admin?onglet=disputes'),
    line(teamDisputes, 'contestation en Division ou en coupe', 'contestations en Division ou en coupe', '/admin?onglet=disputes'),
    line(arbitrations, "demande d'arbitrage", "demandes d'arbitrage", '/admin?onglet=arbitrages'),
    line(reports, 'signalement', 'signalements', '/admin?onglet=signalements'),
  ].filter(Boolean);
  await notifyStaff(`⏰ **En attente de l'équipe**\n${parts.map((part) => `• ${part}`).join('\n')}`);
}
