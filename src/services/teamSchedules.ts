import { config } from '../config.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { discordEnabled, dm } from './discord.js';
import { pushToUsers } from './push.js';
import { checkMatchRoster, forfeitBlockedUntil, teamPlayState, tryCreateTeamMatches } from './teamMatches.js';
import { membershipOf } from './teams.js';

/**
 * Match de Division programmé (migration 0048, table privée team_schedules) : un Leader choisit un créneau (tous les
 * quarts d'heure, de 20 min à 48 h) et les joueurs du match. Rappel 30 min avant ; 5 min avant (adversaire dévoilé),
 * l'équipe entre dans la file en tête (date de programmation) : deux équipes du même créneau s'affrontent, sinon la
 * recherche continue comme une recherche normale (30 min). Une programmation par équipe.
 */

const STEP_MS = 15 * 60_000;
const MIN_AHEAD_MS = 20 * 60_000;
const MAX_AHEAD_MS = 48 * 3600_000;
export const REVEAL_MINUTES = 5;
const REMIND_MINUTES = 30;
const PAGE = '/cod/equipe';

interface ScheduleRow {
  team_id: string;
  roster: string[];
  slot: string;
  created_by: string;
  created_at: string;
  reminded: boolean;
}

const hourOf = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

async function leaderTeam(userId: string): Promise<string> {
  const member = await membershipOf(userId);
  if (!member) throw new HttpError(409, 'NOT_IN_TEAM', 'Tu ne fais partie d’aucune équipe.');
  if (!(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut programmer un match.');
  return member.team_id;
}

/** Leaders et créateur d'une équipe (rappels). */
async function leadersOf(teamId: string): Promise<string[]> {
  const [team, rows] = await Promise.all([
    supabase.from('teams').select('owner_id').eq('id', teamId).single(),
    supabase.from('team_members').select('user_id').eq('team_id', teamId).eq('role', 'leader'),
  ]);
  return [(team.data as { owner_id: string } | null)?.owner_id, ...((rows.data ?? []) as { user_id: string }[]).map((r) => r.user_id)].filter(Boolean) as string[];
}

async function notify(userIds: string[], title: string, body: string) {
  const ids = [...new Set(userIds)];
  await pushToUsers(ids, { title, body, url: PAGE, tag: 'match-programme' });
  if (discordEnabled && config.teams.discord) await dm(ids, `**${title}**\n${body}\n${config.siteUrl}${PAGE}`).catch(() => {});
}

/** Programmer (ou déplacer) le match de son équipe : { slot (ISO, quart d'heure), roster }. */
export async function scheduleTeamMatch(userId: string, body: unknown) {
  if (!config.teams.enabled) throw new HttpError(403, 'TEAM_MODE_PAUSED', 'La Division est en pause.');
  const teamId = await leaderTeam(userId);
  const input = (body ?? {}) as { slot?: unknown; roster?: unknown };
  const slot = typeof input.slot === 'string' ? new Date(input.slot) : null;
  const ahead = slot ? slot.getTime() - Date.now() : NaN;
  if (!slot || Number.isNaN(ahead) || slot.getTime() % STEP_MS !== 0 || ahead < MIN_AHEAD_MS || ahead > MAX_AHEAD_MS) {
    throw new HttpError(400, 'INVALID_SLOT', 'Choisis un créneau au quart d’heure, entre dans 20 minutes et dans 48 heures.');
  }
  const blocked = await forfeitBlockedUntil(teamId);
  if (blocked) throw new HttpError(403, 'TEAM_FORFEIT_BLOCKED', 'Trop de forfaits récents : impossible de programmer un match pour le moment.');
  const roster = await checkMatchRoster(teamId, input.roster);
  unwrap(await supabase.from('team_schedules').upsert({ team_id: teamId, roster, slot: slot.toISOString(), created_by: userId, created_at: new Date().toISOString(), reminded: false }));
  return teamPlayState(userId);
}

/** Annuler la programmation de son équipe. */
export async function cancelTeamSchedule(userId: string) {
  const teamId = await leaderTeam(userId);
  unwrap(await supabase.from('team_schedules').delete().eq('team_id', teamId));
  return teamPlayState(userId);
}

/** Programmation de l'équipe (état « jouer » de Mon équipe). */
export async function scheduleOf(teamId: string) {
  const row = unwrap(await supabase.from('team_schedules').select('roster, slot').eq('team_id', teamId).maybeSingle()) as Pick<ScheduleRow, 'roster' | 'slot'> | null;
  if (!row) return null;
  return { slot: row.slot, roster: row.roster, revealAt: new Date(new Date(row.slot).getTime() - REVEAL_MINUTES * 60_000).toISOString() };
}

/** Créneaux déjà choisis par des équipes (anonymes) : { [slot ISO]: nombre d'équipes }. */
export async function scheduleSlots() {
  const rows = (unwrap(await supabase.from('team_schedules').select('slot').gt('slot', new Date().toISOString())) ?? []) as { slot: string }[];
  const slots: Record<string, number> = {};
  for (const row of rows) {
    const key = new Date(row.slot).toISOString();
    slots[key] = (slots[key] ?? 0) + 1;
  }
  return { slots, stepMinutes: STEP_MS / 60_000, revealMinutes: REVEAL_MINUTES };
}

/** Tâche des équipes : rappel 30 min avant, entrée dans la file 5 min avant. */
export async function sweepTeamSchedules(): Promise<void> {
  try {
    const now = Date.now();
    const rows = (unwrap(await supabase.from('team_schedules').select('*').lte('slot', new Date(now + REMIND_MINUTES * 60_000).toISOString())) ?? []) as ScheduleRow[];
    let queued = false;
    for (const row of rows) {
      const slot = new Date(row.slot).getTime();
      const players = [...row.roster, ...(await leadersOf(row.team_id))];
      if (now >= slot - REVEAL_MINUTES * 60_000) {
        // Fin de la programmation (une seule tâche la traite) puis entrée dans la file.
        const { data: taken } = await supabase.from('team_schedules').delete().eq('team_id', row.team_id).eq('slot', row.slot).select('team_id');
        if (!taken?.length) continue;
        const reason = await cannotQueue(row);
        if (reason) {
          await notify(players, 'Match programmé annulé', reason);
          continue;
        }
        const at = new Date().toISOString();
        unwrap(await supabase.from('team_queue').upsert({ team_id: row.team_id, roster: row.roster, queued_by: row.created_by, joined_at: row.created_at, confirmed_at: at, warned_at: null }));
        await supabase.from('teams').update({ queue_expired_at: null }).eq('id', row.team_id);
        queued = true;
      } else if (!row.reminded) {
        const { data: claimed } = await supabase.from('team_schedules').update({ reminded: true }).eq('team_id', row.team_id).eq('reminded', false).select('team_id');
        if (claimed?.length) {
          await notify(players, `⏰ Match programmé à ${hourOf(row.slot)}`, `Adversaire dévoilé à ${hourOf(new Date(slot - REVEAL_MINUTES * 60_000).toISOString())}. Soyez prêts.`);
        }
      }
    }
    if (queued) await tryCreateTeamMatches();
  } catch (caught) {
    console.error('[match programmé]', (caught as Error).message);
  }
}

/** Raison d'annuler une programmation au moment d'entrer en file (match en cours, tournoi, joueurs indisponibles), ou null. */
async function cannotQueue(row: ScheduleRow): Promise<string | null> {
  const { data: active } = await supabase
    .from('team_matches')
    .select('id')
    .in('status', ['in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed'])
    .or(`team_a.eq.${row.team_id},team_b.eq.${row.team_id}`)
    .limit(1);
  if (active?.length) return 'Ton équipe avait déjà un match en cours à l’heure du créneau.';
  const { teamBusyInTournament } = await import('./tournaments.js');
  if (await teamBusyInTournament(row.team_id)) return 'Ton équipe joue un tournoi : pas de match ordinaire pour le moment.';
  try {
    await checkMatchRoster(row.team_id, row.roster);
  } catch (caught) {
    return caught instanceof HttpError ? `Joueurs du match indisponibles : ${caught.message}` : 'Joueurs du match indisponibles.';
  }
  return null;
}
