import { randomInt } from 'node:crypto';
import { findFormat } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { bus } from '../events.js';
import { supabase } from '../supabase.js';

/**
 * Groupes (« parties ») : jouer à plusieurs dans la même équipe.
 *
 *   - un joueur appartient au plus à un groupe ;
 *   - le chef choisit le format (2v2, 5v5…) et lance la file pour tout le groupe ;
 *   - on rejoint un groupe avec son code d'invitation (lien /cod/groupe/<code>) ;
 *   - toute modification du groupe (arrivée, départ, format) le retire de la file,
 *     pour que la file ne contienne jamais un groupe différent de celui affiché.
 *
 * Toutes les modifications passent par une file d'attente interne (une seule à la
 * fois) : deux joueurs qui rejoignent au même instant ne peuvent pas dépasser la
 * taille maximale. Le serveur tourne en une seule instance (voir CLAUDE.md).
 */

export interface PartyMember {
  id: string;
  username: string;
  avatar_url: string | null;
  activision_id: string | null;
  isLeader: boolean;
}

export interface Party {
  id: string;
  leaderId: string;
  format: string;
  maxSize: number;
  inviteCode: string;
  members: PartyMember[];
}

/** Ce qu'un joueur voit d'une invitation avant de la rejoindre (public). */
export interface PartyPreview {
  leader: string;
  format: string;
  size: number;
  maxSize: number;
}

// --- Exclusion mutuelle ---------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

// --- Lecture ----------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I
const newCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

async function membersOf(partyId: string, leaderId: string): Promise<PartyMember[]> {
  const rows = (unwrap(
    await supabase.from('cod_party_members').select('user_id, joined_at').eq('party_id', partyId).order('joined_at'),
  ) ?? []) as { user_id: string }[];
  const ids = rows.map((row) => row.user_id);
  if (ids.length === 0) return [];
  const [users, profiles] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').in('id', ids),
    supabase.from('cod_profiles').select('user_id, activision_id').in('user_id', ids),
  ]);
  if (users.error) throw fromDbError(users.error);
  if (profiles.error) throw fromDbError(profiles.error);
  const userById = new Map(((users.data ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((u) => [u.id, u]));
  const activision = new Map(((profiles.data ?? []) as { user_id: string; activision_id: string | null }[]).map((p) => [p.user_id, p.activision_id]));
  return ids.map((id) => ({
    id,
    username: userById.get(id)?.username ?? 'Joueur',
    avatar_url: userById.get(id)?.avatar_url ?? null,
    activision_id: activision.get(id) ?? null,
    isLeader: id === leaderId,
  }));
}

async function partyById(partyId: string): Promise<Party | null> {
  const row = unwrap(await supabase.from('cod_parties').select('*').eq('id', partyId).maybeSingle()) as {
    id: string;
    leader_id: string;
    format: string;
    invite_code: string;
  } | null;
  if (!row) return null;
  return {
    id: row.id,
    leaderId: row.leader_id,
    format: row.format,
    maxSize: findFormat(row.format)?.teamSize ?? 5,
    inviteCode: row.invite_code,
    members: await membersOf(row.id, row.leader_id),
  };
}

async function partyIdOf(userId: string): Promise<string | null> {
  const row = unwrap(await supabase.from('cod_party_members').select('party_id').eq('user_id', userId).maybeSingle()) as {
    party_id: string;
  } | null;
  return row?.party_id ?? null;
}

/** Groupe du joueur (avec ses membres), ou null s'il joue seul. */
export async function getPartyOf(userId: string): Promise<Party | null> {
  const partyId = await partyIdOf(userId);
  return partyId ? partyById(partyId) : null;
}

export async function previewInvite(code: string): Promise<PartyPreview> {
  const row = unwrap(await supabase.from('cod_parties').select('id, leader_id, format').eq('invite_code', normalizeCode(code)).maybeSingle()) as {
    id: string;
    leader_id: string;
    format: string;
  } | null;
  if (!row) throw new HttpError(404, 'PARTY_NOT_FOUND', "Cette invitation n'existe plus.");
  const members = await membersOf(row.id, row.leader_id);
  return {
    leader: members.find((member) => member.isLeader)?.username ?? 'Un joueur',
    format: row.format,
    size: members.length,
    maxSize: findFormat(row.format)?.teamSize ?? 5,
  };
}

const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

// --- Modifications ------------------------------------------------------------------

/** Retire le groupe de la file s'il y était, et prévient ses membres. */
async function dequeueParty(partyId: string, reason: string): Promise<void> {
  const removed = (unwrap(await supabase.from('cod_queue').delete().eq('group_id', partyId).select('user_id')) ?? []) as { user_id: string }[];
  if (removed.length === 0) return;
  for (const { user_id } of removed) bus.emit('queue:user', user_id);
  bus.emit('notice', removed.map((row) => row.user_id), reason);
  bus.emit('queue:changed');
}

/** Retire un joueur seul de la file (avant qu'il ne crée ou rejoigne un groupe). */
async function dequeueUser(userId: string): Promise<void> {
  const entry = unwrap(await supabase.from('cod_queue').select('group_id').eq('user_id', userId).maybeSingle()) as { group_id: string } | null;
  if (!entry) return;
  const removed = (unwrap(await supabase.from('cod_queue').delete().eq('group_id', entry.group_id).select('user_id')) ?? []) as { user_id: string }[];
  for (const { user_id } of removed) bus.emit('queue:user', user_id);
  bus.emit('queue:changed');
}

async function assertNotInMatch(userId: string): Promise<void> {
  const active = unwrap(await supabase.rpc('cod_active_match_id', { p_user: userId }));
  if (active) throw new HttpError(409, 'ALREADY_IN_MATCH', 'Termine ton match en cours avant de changer de groupe.');
}

/** Prévient tous les membres (actuels et partis) de l'état du groupe. */
function announce(party: Party | null, alsoNotify: string[] = []): void {
  bus.emit('party:changed', party, alsoNotify);
}

export function createParty(userId: string, formatId: unknown): Promise<Party> {
  return exclusive(async () => {
    const format = findFormat(formatId);
    if (!format) throw new HttpError(400, 'INVALID_FORMAT', 'Format de file inconnu.');
    if (format.teamSize < 2) throw new HttpError(400, 'INVALID_FORMAT', 'Ce format se joue seul.');
    if (await partyIdOf(userId)) throw new HttpError(409, 'ALREADY_IN_PARTY', 'Tu fais déjà partie d’un groupe : quitte-le d’abord.');
    await assertNotInMatch(userId);
    await dequeueUser(userId);

    let partyId = '';
    for (let attempt = 0; attempt < 5 && !partyId; attempt += 1) {
      const { data, error } = await supabase
        .from('cod_parties')
        .insert({ leader_id: userId, format: format.id, invite_code: newCode() })
        .select('id')
        .single();
      if (!error && data) partyId = (data as { id: string }).id;
      else if (error && !/invite_code/.test(error.message)) throw fromDbError(error);
    }
    if (!partyId) throw new HttpError(500, 'INTERNAL_ERROR', 'Création du groupe impossible. Réessaie.');
    unwrap(await supabase.from('cod_party_members').insert({ user_id: userId, party_id: partyId }));

    const party = (await partyById(partyId)) as Party;
    announce(party);
    return party;
  });
}

export function joinParty(userId: string, rawCode: unknown): Promise<Party> {
  return exclusive(async () => {
    if (typeof rawCode !== 'string') throw new HttpError(400, 'INVALID_CODE', "Code d'invitation invalide.");
    const row = unwrap(await supabase.from('cod_parties').select('id').eq('invite_code', normalizeCode(rawCode)).maybeSingle()) as {
      id: string;
    } | null;
    if (!row) throw new HttpError(404, 'PARTY_NOT_FOUND', "Cette invitation n'existe plus.");

    const current = await partyIdOf(userId);
    if (current === row.id) return (await partyById(row.id)) as Party;
    await assertNotInMatch(userId);

    const target = (await partyById(row.id)) as Party;
    if (target.members.length >= target.maxSize) {
      throw new HttpError(409, 'PARTY_FULL', `Ce groupe est complet (${target.maxSize} joueurs en ${target.format}).`);
    }
    for (const member of target.members) {
      const active = unwrap(await supabase.rpc('cod_active_match_id', { p_user: member.id }));
      if (active) throw new HttpError(409, 'PARTY_IN_MATCH', 'Ce groupe joue un match : réessaie quand il sera terminé.');
    }

    if (current) await leaveInternal(userId, current);
    await dequeueUser(userId);
    await dequeueParty(row.id, 'Un joueur a rejoint le groupe : la recherche a été annulée, relancez-la.');
    unwrap(await supabase.from('cod_party_members').insert({ user_id: userId, party_id: row.id }));

    const party = (await partyById(row.id)) as Party;
    announce(party);
    return party;
  });
}

/** Départ d'un membre (sans verrou : appelé depuis une opération déjà exclusive). */
async function leaveInternal(userId: string, partyId: string, reason = 'Un joueur a quitté le groupe : la recherche a été annulée.'): Promise<void> {
  const party = await partyById(partyId);
  if (!party) return;
  await dequeueParty(partyId, reason);
  unwrap(await supabase.from('cod_party_members').delete().eq('user_id', userId));

  const remaining = party.members.filter((member) => member.id !== userId);
  if (remaining.length === 0) {
    unwrap(await supabase.from('cod_parties').delete().eq('id', partyId));
    announce(null, [userId]);
    return;
  }
  if (party.leaderId === userId) {
    // Le plus ancien membre devient chef.
    unwrap(await supabase.from('cod_parties').update({ leader_id: remaining[0]?.id }).eq('id', partyId));
  }
  announce(await partyById(partyId), [userId]);
}

export function leaveParty(userId: string): Promise<void> {
  return exclusive(async () => {
    const partyId = await partyIdOf(userId);
    if (!partyId) return;
    await assertNotInMatch(userId);
    await leaveInternal(userId, partyId);
  });
}

export function kickMember(leaderId: string, targetId: unknown): Promise<Party> {
  return exclusive(async () => {
    const partyId = await partyIdOf(leaderId);
    const party = partyId ? await partyById(partyId) : null;
    if (!party || party.leaderId !== leaderId) throw new HttpError(403, 'NOT_PARTY_LEADER', 'Seul le chef du groupe peut faire cela.');
    if (typeof targetId !== 'string' || targetId === leaderId || !party.members.some((member) => member.id === targetId)) {
      throw new HttpError(400, 'INVALID_MEMBER', 'Ce joueur ne fait pas partie du groupe.');
    }
    await leaveInternal(targetId, party.id, 'Un joueur a été retiré du groupe : la recherche a été annulée.');
    bus.emit('notice', [targetId], 'Tu as été retiré du groupe par son chef.');
    return (await partyById(party.id)) as Party;
  });
}

export function setPartyFormat(leaderId: string, formatId: unknown): Promise<Party> {
  return exclusive(async () => {
    const partyId = await partyIdOf(leaderId);
    const party = partyId ? await partyById(partyId) : null;
    if (!party || party.leaderId !== leaderId) throw new HttpError(403, 'NOT_PARTY_LEADER', 'Seul le chef du groupe peut faire cela.');
    const format = findFormat(formatId);
    if (!format) throw new HttpError(400, 'INVALID_FORMAT', 'Format de file inconnu.');
    if (party.members.length > format.teamSize) {
      throw new HttpError(409, 'INVALID_GROUP_SIZE', `Le groupe compte ${party.members.length} joueurs : trop pour du ${format.id}.`);
    }
    if (format.id === party.format) return party;
    await dequeueParty(party.id, 'Le chef a changé de format : la recherche a été annulée.');
    unwrap(await supabase.from('cod_parties').update({ format: format.id }).eq('id', party.id));
    const updated = (await partyById(party.id)) as Party;
    announce(updated);
    return updated;
  });
}
