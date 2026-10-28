import { randomUUID } from 'node:crypto';
import { config, findFormat, type QueueFormat } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { bus, type CodMatch, type ReadyCheckFailure } from '../events.js';
import { supabase } from '../supabase.js';
import { findMatch, membersOf, randomSplit, type QueueGroup } from './matchmaker.js';
import { getPartyOf, type Party } from './parties.js';
import { expiresAt, queueTimeouts, type TimeoutRules } from './queuePolicy.js';
import { mapPool } from './maps.js';

/** Durée maximale de recherche (voir queuePolicy.ts). */
const TIMEOUT_RULES: TimeoutRules = {
  maxMs: config.cod.queueMaxMinutes * 60_000,
  warnMs: config.cod.queueWarnMinutes * 60_000,
};

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
  /** Heure d'arrêt de la recherche sans nouvelle confirmation, ou null. */
  expiresAt: string | null;
  /** Message « Toujours là ? » en attente de réponse. */
  stillThere: boolean;
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
    supabase.from('cod_queue').select('joined_at, format, group_size, confirmed_at, warned_at').eq('user_id', userId).maybeSingle(),
    supabase.rpc('cod_active_match_id', { p_user: userId }),
    supabase.from('cod_profiles').select('banned_until').eq('user_id', userId).maybeSingle(),
    config.cod.groupsEnabled ? getPartyOf(userId) : Promise.resolve(null),
  ]);
  if (entry.error) throw fromDbError(entry.error);
  if (active.error) throw fromDbError(active.error);
  if (profile.error) throw fromDbError(profile.error);

  const row = entry.data as { joined_at: string; format: string; group_size: number; confirmed_at: string; warned_at: string | null } | null;
  const bannedUntil = (profile.data?.banned_until as string | null | undefined) ?? null;
  return {
    queues,
    inQueue: Boolean(row),
    format: row?.format ?? null,
    groupSize: row?.group_size ?? 1,
    joinedAt: row?.joined_at ?? null,
    expiresAt: row ? new Date(expiresAt(new Date(row.confirmed_at).getTime(), TIMEOUT_RULES)).toISOString() : null,
    stillThere: Boolean(row?.warned_at),
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
  // Classé solo (groupes coupés) : chacun entre seul, même s'il lui reste un ancien groupe.
  const party = config.cod.groupsEnabled ? await getPartyOf(userId) : null;
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

/**
 * « Rester en file » : le joueur (ou un membre de son groupe) confirme sa présence.
 * Le compteur repart pour la durée maximale ; la place dans la file est conservée.
 */
export async function stayInQueue(userId: string): Promise<void> {
  const entry = unwrap(await supabase.from('cod_queue').select('group_id').eq('user_id', userId).maybeSingle()) as { group_id: string } | null;
  if (!entry) throw new HttpError(409, 'NOT_IN_QUEUE', "Tu n'es plus dans la file : relance une recherche.");
  const members = ((unwrap(
    await supabase
      .from('cod_queue')
      .update({ confirmed_at: new Date().toISOString(), warned_at: null })
      .eq('group_id', entry.group_id)
      .select('user_id'),
  ) ?? []) as { user_id: string }[]).map((row) => row.user_id);
  for (const member of members) bus.emit('queue:user', member);
}

/**
 * Durée maximale de recherche (appelé toutes les 20 secondes) : « Toujours là ? »
 * 5 min avant la fin, puis arrêt de la recherche des groupes qui n'ont pas répondu.
 */
export async function checkQueueTimeouts(): Promise<void> {
  const { data, error } = await supabase.from('cod_queue').select('user_id, group_id, confirmed_at, warned_at');
  if (error) {
    console.error('[file] durée maximale', error.message);
    return;
  }
  const rows = (data ?? []) as { user_id: string; group_id: string; confirmed_at: string; warned_at: string | null }[];
  if (rows.length === 0) return;

  const groups = new Map<string, { groupId: string; confirmedAt: number; warnedAt: number | null }>();
  for (const row of rows) {
    if (!groups.has(row.group_id)) {
      groups.set(row.group_id, {
        groupId: row.group_id,
        confirmedAt: new Date(row.confirmed_at).getTime(),
        warnedAt: row.warned_at ? new Date(row.warned_at).getTime() : null,
      });
    }
  }
  const now = Date.now();
  const { warn, expire } = queueTimeouts([...groups.values()], now, TIMEOUT_RULES);

  for (const groupId of warn) {
    // Conditions répétées dans la requête : un « Rester en file » arrivé entre-temps l'emporte.
    const warned = ((unwrap(
      await supabase
        .from('cod_queue')
        .update({ warned_at: new Date(now).toISOString() })
        .eq('group_id', groupId)
        .is('warned_at', null)
        .lte('confirmed_at', new Date(now - (TIMEOUT_RULES.maxMs - TIMEOUT_RULES.warnMs)).toISOString())
        .select('user_id'),
    ) ?? []) as { user_id: string }[]).map((row) => row.user_id);
    if (warned.length === 0) continue;
    for (const member of warned) bus.emit('queue:user', member);
    bus.emit('queue:warned', warned);
  }

  let expired = 0;
  for (const groupId of expire) {
    const removed = ((unwrap(
      await supabase
        .from('cod_queue')
        .delete()
        .eq('group_id', groupId)
        .lte('confirmed_at', new Date(now - TIMEOUT_RULES.maxMs).toISOString())
        .select('user_id'),
    ) ?? []) as { user_id: string }[]).map((row) => row.user_id);
    if (removed.length === 0) continue;
    expired += removed.length;
    for (const member of removed) bus.emit('queue:user', member);
    bus.emit('notice', removed, `Aucun match trouvé en ${config.cod.queueMaxMinutes} min : ta recherche est arrêtée. Relance-la quand tu veux.`);
    bus.emit('queue:expired', removed);
  }
  if (expired > 0) {
    console.log(`[file] ${expired} joueur(s) sorti(s) de la file après ${config.cod.queueMaxMinutes} min sans confirmation`);
    bus.emit('queue:changed');
  }
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
    const chosen = findMatch(await readGroups(format), format.teamSize);
    if (!chosen) return;

    // Joueurs choisis dans l'ordre d'arrivée ; équipes, côtés et hôte tirés au sort.
    const proposal = randomSplit(chosen, format.teamSize);
    const teamA = membersOf(proposal.teamA);
    const teamB = membersOf(proposal.teamB);

    const created = unwrap(
      await supabase.rpc('cod_create_group_match', {
        p_format: format.id,
        p_team_size: format.teamSize,
        p_team_a: teamA,
        p_team_b: teamB,
        p_maps: await mapPool('classe'),
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
  // « Prêt ? » facultatif : à la fin du compte à rebours, le match démarre pour tout le monde (pas d'annulation).
  if (!config.cod.readyRequired) await startAfterCountdown();
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

/** Matchs trouvés dont le compte à rebours est fini : démarrés (« Prêt ? » facultatif, COD_READY_REQUIRED différent de « on »). */
async function startAfterCountdown(): Promise<void> {
  const { data, error } = await supabase.from('cod_matches').select('id').eq('status', 'ready_check').lte('ready_deadline', new Date().toISOString());
  if (error) {
    console.error('[prêt]', error.message);
    return;
  }
  for (const { id } of (data ?? []) as { id: string }[]) {
    const { data: started, error: startError } = await supabase.rpc('cod_start_after_ready', { p_match: id });
    if (startError) {
      console.error('[prêt] démarrage impossible', startError.message);
      continue;
    }
    const match = started as CodMatch | null;
    if (match?.status === 'in_progress') bus.emit('match:start', match);
  }
}

/** Vide la file. Appelé au démarrage : après un redémarrage, plus personne n'est connecté. */
export async function clearQueue(): Promise<void> {
  const { error } = await supabase.from('cod_queue').delete().not('user_id', 'is', null);
  if (error) throw fromDbError(error);
}
