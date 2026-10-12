import { randomUUID } from 'node:crypto';
import { config, findFormat, type QueueFormat } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { bus, type CodMatch, type ReadyCheckFailure } from '../events.js';
import { supabase } from '../supabase.js';
import { findMatch, membersOf, type QueueGroup } from './matchmaker.js';
import { getPartyOf, type Party } from './parties.js';

/** Une file telle qu'affichée sur la page Ranked. */
export interface QueueSummary {
  format: string;
  label: string;
  teamSize: number;
  /** Joueurs actuellement dans cette file. */
  size: number;
  /** Joueurs nécessaires pour lancer un match. */
  needed: number;
}

/** Ce qu'un joueur a besoin de savoir pour afficher la page de file d'attente. */
export interface QueueState {
  queues: QueueSummary[];
  inQueue: boolean;
  /** File dans laquelle il se trouve (« 2v2 »…), ou null. */
  format: string | null;
  /** Taille de son groupe dans la file (1 = seul). */
  groupSize: number;
  joinedAt: string | null;
  /** Match en cours du joueur, s'il en a un (il doit le terminer avant de relancer). */
  activeMatchId: string | null;
  /** Fin de l'exclusion temporaire de la file (sanction), ou null. */
  bannedUntil: string | null;
  party: Party | null;
}

export async function getQueueSummaries(): Promise<QueueSummary[]> {
  const rows = (unwrap(await supabase.from('cod_queue').select('format')) ?? []) as { format: string }[];
  return config.cod.formats.map((format) => ({
    format: format.id,
    label: format.label,
    teamSize: format.teamSize,
    size: rows.filter((row) => row.format === format.id).length,
    needed: format.teamSize * 2,
  }));
}

/** Nombre total de joueurs en file, tous formats confondus. */
export async function getQueueSize(): Promise<number> {
  const { count, error } = await supabase.from('cod_queue').select('user_id', { count: 'exact', head: true });
  if (error) throw fromDbError(error);
  return count ?? 0;
}

export async function getQueueState(userId: string): Promise<QueueState> {
  const [queues, entry, active, profile, party] = await Promise.all([
    getQueueSummaries(),
    supabase.from('cod_queue').select('joined_at, format, group_size').eq('user_id', userId).maybeSingle(),
    supabase.rpc('cod_active_match_id', { p_user: userId }),
    supabase.from('cod_profiles').select('banned_until').eq('user_id', userId).maybeSingle(),
    getPartyOf(userId),
  ]);
  if (entry.error) throw fromDbError(entry.error);
  if (active.error) throw fromDbError(active.error);
  if (profile.error) throw fromDbError(profile.error);

  const row = entry.data as { joined_at: string; format: string; group_size: number } | null;
  const bannedUntil = (profile.data?.banned_until as string | null | undefined) ?? null;
  return {
    queues,
    inQueue: Boolean(row),
    format: row?.format ?? null,
    groupSize: row?.group_size ?? 1,
    joinedAt: row?.joined_at ?? null,
    activeMatchId: (active.data as string | null) ?? null,
    bannedUntil: bannedUntil && new Date(bannedUntil).getTime() > Date.now() ? bannedUntil : null,
    party,
  };
}

/** Codes d'erreur de groupe ramenés à leur version « solo » quand le joueur est seul. */
const SOLO_ERRORS: Record<string, string> = {
  MEMBER_PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  MEMBER_BANNED: 'QUEUE_BANNED',
  MEMBER_IN_MATCH: 'ALREADY_IN_MATCH',
};

/**
 * Fait entrer un joueur seul (format choisi) ou tout son groupe (format du groupe,
 * chef uniquement) dans la file, puis tente de lancer un match.
 * isConnected : les membres doivent avoir le site ouvert pour être prévenus du match.
 */
export async function joinQueue(userId: string, formatId: unknown, isConnected: (id: string) => boolean): Promise<void> {
  const party = await getPartyOf(userId);
  let format: QueueFormat | undefined;
  let members: string[];
  let groupId: string;

  if (party) {
    if (party.leaderId !== userId) throw new HttpError(403, 'NOT_PARTY_LEADER', 'Seul le chef du groupe peut lancer la recherche.');
    format = findFormat(party.format);
    members = party.members.map((member) => member.id);
    groupId = party.id;
    const offline = party.members.find((member) => !isConnected(member.id));
    if (offline) {
      throw new HttpError(409, 'MEMBER_OFFLINE', `${offline.username} doit avoir le site ouvert (page File classée) pour être prévenu du match.`);
    }
  } else {
    format = findFormat(formatId);
    members = [userId];
    groupId = randomUUID();
    if (!isConnected(userId)) {
      throw new HttpError(409, 'SOCKET_REQUIRED', 'Connexion temps réel indisponible. Recharge la page et réessaie.');
    }
  }
  if (!format) throw new HttpError(400, 'INVALID_FORMAT', 'Format de file inconnu.');
  if (members.length > format.teamSize) {
    throw new HttpError(409, 'INVALID_GROUP_SIZE', `Ton groupe compte ${members.length} joueurs : trop pour du ${format.id}.`);
  }

  const { error } = await supabase.rpc('cod_join_queue_group', {
    p_format: format.id,
    p_team_size: format.teamSize,
    p_members: members,
    p_group: groupId,
  });
  if (error) {
    const soloCode = members.length === 1 ? SOLO_ERRORS[error.message] : undefined;
    throw fromDbError(soloCode ? { message: soloCode } : error);
  }

  for (const member of members) bus.emit('queue:user', member);
  await runMatchmaking(format);
  bus.emit('queue:changed');
}

/**
 * Retire le joueur de la file, avec tout son groupe (un groupe n'est jamais en
 * file à moitié). Renvoie les joueurs retirés.
 */
export async function leaveQueue(userId: string, reason?: string): Promise<string[]> {
  const entry = unwrap(await supabase.from('cod_queue').select('group_id').eq('user_id', userId).maybeSingle()) as { group_id: string } | null;
  if (!entry) return [];
  const removed = ((unwrap(await supabase.from('cod_queue').delete().eq('group_id', entry.group_id).select('user_id')) ?? []) as {
    user_id: string;
  }[]).map((row) => row.user_id);

  for (const member of removed) bus.emit('queue:user', member);
  const others = removed.filter((member) => member !== userId);
  if (others.length > 0) bus.emit('notice', others, reason ?? 'Un membre du groupe a quitté la file : recherche annulée.');
  if (removed.length > 0) bus.emit('queue:changed');
  return removed;
}

/** Lit la file d'un format, regroupée par groupe. */
async function readGroups(format: QueueFormat): Promise<QueueGroup[]> {
  const rows = (unwrap(
    await supabase.from('cod_queue').select('user_id, group_id, joined_at').eq('format', format.id).order('joined_at').limit(500),
  ) ?? []) as { user_id: string; group_id: string; joined_at: string }[];
  const groups = new Map<string, QueueGroup>();
  for (const row of rows) {
    const group = groups.get(row.group_id) ?? { id: row.group_id, members: [], joinedAt: new Date(row.joined_at).getTime() };
    group.members.push(row.user_id);
    groups.set(row.group_id, group);
  }
  return [...groups.values()];
}

/**
 * Crée autant de matchs que la file d'un format le permet.
 * Le serveur propose les équipes (matchmaker.ts) ; la base les revérifie et crée
 * le match de façon atomique. Si la file a bougé entre-temps, on recalcule.
 */
export async function runMatchmaking(format: QueueFormat): Promise<void> {
  // Garde-fou : on ne boucle jamais indéfiniment, même en cas de comportement inattendu.
  for (let round = 0; round < 20; round += 1) {
    const proposal = findMatch(await readGroups(format), format.teamSize);
    if (!proposal) return;

    // Côté (équipe 1 / équipe 2) tiré au sort : l'équipe 1 fournit l'hôte de la partie.
    const swap = Math.random() < 0.5;
    const teamA = membersOf(swap ? proposal.teamB : proposal.teamA);
    const teamB = membersOf(swap ? proposal.teamA : proposal.teamB);

    const created = unwrap(
      await supabase.rpc('cod_create_group_match', {
        p_format: format.id,
        p_team_size: format.teamSize,
        p_team_a: teamA,
        p_team_b: teamB,
        p_maps: config.cod.maps,
        p_modes: config.cod.modes,
        p_ready_seconds: config.cod.readySeconds,
      }),
    ) as CodMatch[] | null;

    const match = created?.[0];
    if (!match) {
      console.warn(`[matchmaking] ${format.id} : la file a changé pendant la création, nouveau calcul`);
      continue;
    }
    console.log(`[matchmaking] ${format.id} : match ${match.id} trouvé (${match.map} / ${match.mode}), vérification ouverte`);
    bus.emit('match:found', match);
  }
}

/** Matchmaking de toutes les files (après une annulation, au démarrage…). */
export async function runAllMatchmaking(): Promise<void> {
  for (const format of config.cod.formats) await runMatchmaking(format);
}

/**
 * Clôt les vérifications « Prêt ? » expirées (appelé toutes les quelques secondes) :
 * match annulé, groupes complets remis en tête de file, absents sanctionnés.
 * Relance ensuite le matchmaking, puisque la file a pu se remplir.
 */
export async function expireReadyChecks(): Promise<void> {
  const { data, error } = await supabase.rpc('cod_expire_ready_checks');
  if (error) {
    console.error('[ready]', error.message);
    return;
  }
  const failures = (data ?? []) as ReadyCheckFailure[];
  if (failures.length === 0) return;

  for (const failure of failures) {
    console.log(`[ready] match ${failure.match_id} annulé : ${failure.missing.length} joueur(s) absent(s)`);
    bus.emit('match:aborted', failure);
  }
  await runAllMatchmaking();
  bus.emit('queue:changed');
}

/** Vide la file. Appelé au démarrage : après un redémarrage, plus personne n'est connecté. */
export async function clearQueue(): Promise<void> {
  const { error } = await supabase.from('cod_queue').delete().not('user_id', 'is', null);
  if (error) throw fromDbError(error);
}
