import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { dm } from './discord.js';
import { pushToUsers } from './push.js';
import { pickMaps } from './teamMatchPolicy.js';
import { checkMatchRoster, onTeamMatchCreated, type TeamMatch } from './teamMatches.js';
import { membershipOf } from './teams.js';

/**
 * Défis directs (scrims) de la Division : un Leader défie une autre équipe pour un BO3, maintenant ou à une
 * heure fixée, en amical (sans points ni bilan) ou officiel (points de Division). Les Leaders adverses acceptent
 * (en choisissant leurs joueurs) ou refusent ; le match suit la feuille de match habituelle. Un défi sans
 * réponse expire après 24 h (ou à l'heure prévue) ; un défi accepté pour plus tard démarre à l'heure.
 * Table team_challenges et fonction team_match_create_direct (migration 0042).
 */

interface ChallengeRow {
  id: string;
  from_team: string;
  to_team: string;
  created_by: string;
  answered_by: string | null;
  friendly: boolean;
  roster_from: string[];
  roster_to: string[] | null;
  scheduled_at: string | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'played';
  match_id: string | null;
  created_at: string;
  answered_at: string | null;
}

const EXPIRE_MS = 24 * 3600_000;
const PAGE = '/cod/equipe';
const fmtDate = (iso: string) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

async function leadersOf(teamId: string): Promise<string[]> {
  const [team, rows] = await Promise.all([
    supabase.from('teams').select('owner_id').eq('id', teamId).single(),
    supabase.from('team_members').select('user_id').eq('team_id', teamId).eq('role', 'leader'),
  ]);
  return [...new Set([(team.data as { owner_id: string } | null)?.owner_id, ...((rows.data ?? []) as { user_id: string }[]).map((r) => r.user_id)].filter(Boolean) as string[])];
}

async function teamCard(teamId: string) {
  const { data } = await supabase.from('teams').select('id, name, tag, color, logo_url, points, disbanded_at, cup_tournament').eq('id', teamId).maybeSingle();
  return data as { id: string; name: string; tag: string; color: string; logo_url: string | null; points: number; disbanded_at: string | null; cup_tournament: string | null } | null;
}

async function myLeaderTeam(userId: string): Promise<string> {
  const member = await membershipOf(userId);
  if (!member) throw new HttpError(409, 'NOT_IN_TEAM', 'Tu ne fais partie d’aucune équipe.');
  if (!(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut gérer les défis.');
  return member.team_id;
}

async function notify(userIds: string[], title: string, body: string) {
  await pushToUsers(userIds, { title, body, url: PAGE, tag: 'defi' });
  await dm(userIds, `**${title}**\n${body}\n${config.siteUrl}${PAGE}`).catch(() => {});
}

/** Lancer un défi : { teamId (équipe défiée), friendly, roster, scheduledAt?, message? }. */
export async function createChallenge(userId: string, body: unknown) {
  if (!config.teams.enabled) throw new HttpError(403, 'TEAM_MODE_PAUSED', 'La Division est en pause.');
  const fromTeam = await myLeaderTeam(userId);
  const input = (body ?? {}) as { teamId?: unknown; friendly?: unknown; roster?: unknown; scheduledAt?: unknown; message?: unknown };
  const toTeam = typeof input.teamId === 'string' ? input.teamId : '';
  if (!toTeam || toTeam === fromTeam) throw new HttpError(400, 'INVALID_TEAM', 'Choisis une autre équipe à défier.');
  const target = await teamCard(toTeam);
  if (!target || target.disbanded_at || target.cup_tournament) throw new HttpError(404, 'TEAM_NOT_FOUND', 'Équipe introuvable.');
  let scheduledAt: string | null = null;
  if (typeof input.scheduledAt === 'string' && input.scheduledAt) {
    const at = new Date(input.scheduledAt);
    if (Number.isNaN(at.getTime())) throw new HttpError(400, 'INVALID_DATE', 'Date invalide.');
    if (at.getTime() < Date.now() + 10 * 60_000 || at.getTime() > Date.now() + 7 * 86_400_000) throw new HttpError(400, 'INVALID_DATE', 'Choisis un horaire entre dans 10 minutes et dans 7 jours (ou « maintenant »).');
    scheduledAt = at.toISOString();
  }
  const message = typeof input.message === 'string' && input.message.trim() ? input.message.trim().slice(0, 200) : null;
  const roster = await checkMatchRoster(fromTeam, input.roster);
  const { count, error } = await supabase
    .from('team_challenges')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'accepted'])
    .or(`and(from_team.eq.${fromTeam},to_team.eq.${toTeam}),and(from_team.eq.${toTeam},to_team.eq.${fromTeam})`);
  if (error) throw fromDbError(error);
  if ((count ?? 0) > 0) throw new HttpError(409, 'CHALLENGE_EXISTS', 'Un défi est déjà en cours entre vos deux équipes.');
  const friendly = input.friendly !== false;
  unwrap(await supabase.from('team_challenges').insert({ from_team: fromTeam, to_team: toTeam, created_by: userId, friendly, roster_from: roster, scheduled_at: scheduledAt, message }));
  const from = await teamCard(fromTeam);
  await notify(
    await leadersOf(toTeam),
    `⚔️ [${from?.tag}] ${from?.name} vous défie`,
    `BO3 ${friendly ? 'amical (sans points)' : 'officiel (points de Division)'} · ${scheduledAt ? fmtDate(scheduledAt) : 'dès que vous acceptez'}${message ? ` · « ${message} »` : ''}. Réponds depuis Mon équipe.`,
  );
  return myChallenges(userId);
}

/** Répondre à un défi reçu : { accept, roster } (joueurs du match si accepté). */
export async function answerChallenge(userId: string, id: string, body: unknown) {
  const teamId = await myLeaderTeam(userId);
  const challenge = unwrap(await supabase.from('team_challenges').select('*').eq('id', id).maybeSingle()) as ChallengeRow | null;
  if (!challenge || challenge.to_team !== teamId) throw new HttpError(404, 'CHALLENGE_NOT_FOUND', 'Défi introuvable.');
  if (challenge.status !== 'pending') throw new HttpError(409, 'CHALLENGE_CLOSED', 'Ce défi n’attend plus de réponse.');
  const accept = (body as { accept?: unknown } | undefined)?.accept === true;
  const to = await teamCard(teamId);
  if (!accept) {
    unwrap(await supabase.from('team_challenges').update({ status: 'declined', answered_by: userId, answered_at: new Date().toISOString() }).eq('id', id));
    await notify(await leadersOf(challenge.from_team), `Défi refusé par [${to?.tag}] ${to?.name}`, 'Défie une autre équipe ou relance plus tard.');
    return myChallenges(userId);
  }
  const roster = await checkMatchRoster(teamId, (body as { roster?: unknown } | undefined)?.roster);
  const updated = unwrap(
    await supabase
      .from('team_challenges')
      .update({ status: 'accepted', roster_to: roster, answered_by: userId, answered_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle(),
  ) as ChallengeRow | null;
  if (!updated) throw new HttpError(409, 'CHALLENGE_CLOSED', 'Ce défi n’attend plus de réponse.');
  if (!updated.scheduled_at || new Date(updated.scheduled_at).getTime() <= Date.now() + 60_000) {
    await startChallenge(updated);
  } else {
    await notify([...(await leadersOf(challenge.from_team)), ...updated.roster_from, ...roster], `✅ Défi accepté : [${to?.tag}] ${to?.name}`, `Le match démarre ${fmtDate(updated.scheduled_at)}. Soyez prêts à l’heure.`);
  }
  return myChallenges(userId);
}

/** Annuler un défi (Leader d'une des deux équipes), tant que le match n'a pas commencé. */
export async function cancelChallenge(userId: string, id: string) {
  const teamId = await myLeaderTeam(userId);
  const challenge = unwrap(await supabase.from('team_challenges').select('*').eq('id', id).maybeSingle()) as ChallengeRow | null;
  if (!challenge || (challenge.from_team !== teamId && challenge.to_team !== teamId)) throw new HttpError(404, 'CHALLENGE_NOT_FOUND', 'Défi introuvable.');
  if (!['pending', 'accepted'].includes(challenge.status) || challenge.match_id) throw new HttpError(409, 'CHALLENGE_CLOSED', 'Ce défi ne peut plus être annulé.');
  unwrap(await supabase.from('team_challenges').update({ status: 'cancelled', answered_at: new Date().toISOString() }).eq('id', id));
  const other = challenge.from_team === teamId ? challenge.to_team : challenge.from_team;
  const me = await teamCard(teamId);
  await notify(await leadersOf(other), `Défi annulé par [${me?.tag}] ${me?.name}`, 'Le défi ne se jouera pas.');
  return myChallenges(userId);
}

/** Démarre le match d'un défi accepté (rosters revérifiés). En cas d'empêchement, le défi est annulé. */
async function startChallenge(challenge: ChallengeRow): Promise<void> {
  try {
    const { teamBusyInTournament } = await import('./tournaments.js');
    if ((await teamBusyInTournament(challenge.from_team)) || (await teamBusyInTournament(challenge.to_team))) throw new HttpError(409, 'TEAM_IN_TOURNAMENT', 'Une des deux équipes joue un tournoi.');
    const rosterA = await checkMatchRoster(challenge.from_team, challenge.roster_from);
    const rosterB = await checkMatchRoster(challenge.to_team, challenge.roster_to);
    const { data, error } = await supabase.rpc('team_match_create_direct', {
      p_team_a: challenge.from_team,
      p_team_b: challenge.to_team,
      p_roster_a: rosterA,
      p_roster_b: rosterB,
      p_maps: pickMaps(config.cod.maps, 3),
      p_mode: config.cod.modes[0],
      p_friendly: challenge.friendly,
      p_challenge: challenge.id,
    });
    if (error) throw new HttpError(409, 'TEAM_BUSY', error.message.includes('TEAM_BUSY') ? 'Une des deux équipes a déjà un match en cours.' : error.message);
    const match = data as TeamMatch;
    unwrap(await supabase.from('team_challenges').update({ match_id: match.id }).eq('id', challenge.id));
    await onTeamMatchCreated(match).catch((caught) => console.warn('[défi] annonce impossible', (caught as Error).message));
  } catch (caught) {
    unwrap(await supabase.from('team_challenges').update({ status: 'cancelled' }).eq('id', challenge.id));
    const reason = caught instanceof HttpError ? caught.message : 'Impossible de lancer le match.';
    await notify([...(await leadersOf(challenge.from_team)), ...(await leadersOf(challenge.to_team))], 'Défi annulé', reason);
  }
}

/** Tâche périodique : défis sans réponse expirés, défis acceptés lancés à l'heure. */
export async function sweepChallenges(): Promise<void> {
  try {
    const now = Date.now();
    const rows = (unwrap(await supabase.from('team_challenges').select('*').in('status', ['pending', 'accepted']).is('match_id', null)) ?? []) as ChallengeRow[];
    for (const row of rows) {
      if (row.status === 'pending') {
        const deadline = row.scheduled_at ? new Date(row.scheduled_at).getTime() : new Date(row.created_at).getTime() + EXPIRE_MS;
        if (now >= deadline) unwrap(await supabase.from('team_challenges').update({ status: 'expired' }).eq('id', row.id).eq('status', 'pending'));
      } else if (row.scheduled_at && new Date(row.scheduled_at).getTime() <= now) {
        const claimed = unwrap(await supabase.from('team_challenges').update({ answered_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'accepted').is('match_id', null).select('*').maybeSingle()) as ChallengeRow | null;
        if (claimed) await startChallenge(claimed);
      }
    }
  } catch (caught) {
    console.error('[défi] tâche impossible', (caught as Error).message);
  }
}

/** Défis de mon équipe : reçus et envoyés en cours, et les derniers terminés. */
export async function myChallenges(userId: string) {
  const member = await membershipOf(userId);
  if (!member) return { canManage: false, incoming: [], outgoing: [], recent: [] };
  const teamId = member.team_id;
  const rows = (unwrap(
    await supabase.from('team_challenges').select('*').or(`from_team.eq.${teamId},to_team.eq.${teamId}`).order('created_at', { ascending: false }).limit(30),
  ) ?? []) as ChallengeRow[];
  const teamIds = [...new Set(rows.flatMap((r) => [r.from_team, r.to_team]))];
  const { data: teams } = teamIds.length ? await supabase.from('teams').select('id, name, tag, color, logo_url, points').in('id', teamIds) : { data: [] };
  const byId = new Map(((teams ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null; points: number }[]).map((t) => [t.id, t]));
  const card = (id: string) => {
    const t = byId.get(id);
    return t ? { id: t.id, name: t.name, tag: t.tag, color: t.color, logoUrl: t.logo_url, points: t.points } : null;
  };
  const view = (r: ChallengeRow) => ({
    id: r.id,
    status: r.status,
    friendly: r.friendly,
    scheduledAt: r.scheduled_at,
    message: r.message,
    matchId: r.match_id,
    createdAt: r.created_at,
    from: card(r.from_team),
    to: card(r.to_team),
    expiresAt: r.status === 'pending' ? (r.scheduled_at ?? new Date(new Date(r.created_at).getTime() + EXPIRE_MS).toISOString()) : null,
  });
  const open = rows.filter((r) => r.status === 'pending' || (r.status === 'accepted' && !r.match_id));
  return {
    canManage: member.role === 'leader' || member.isOwner,
    rosterSize: config.teams.rosterSize,
    incoming: open.filter((r) => r.to_team === teamId).map(view),
    outgoing: open.filter((r) => r.from_team === teamId).map(view),
    recent: rows.filter((r) => !open.includes(r)).slice(0, 6).map(view),
  };
}
