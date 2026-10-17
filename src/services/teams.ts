import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { discordEnabled, dm, notifyStaff } from './discord.js';
import { rankPlayers } from './playerSearch.js';
import { pushToUsers } from './push.js';
import {
  TEAM_LIMITS,
  TEAM_REPORT_REASONS,
  TeamInputError,
  canDo,
  isOwnTeamMedia,
  leaveCooldownEnd,
  missingRequirements,
  parseTeamInput,
  type TeamActor,
} from './teamPolicy.js';

/**
 * Équipes du mode « Match team » (étape 1 : fiches, effectifs, invitations et candidatures).
 * Règles dans teamPolicy.ts ; opérations atomiques dans les fonctions SQL team_* (migration 0025).
 */

interface TeamRow {
  id: string;
  name: string;
  tag: string;
  description: string | null;
  color: string;
  logo_url: string | null;
  banner_url: string | null;
  socials: Record<string, string>;
  owner_id: string;
  points: number;
  wins: number;
  losses: number;
  created_at: string;
  disbanded_at: string | null;
}

interface MemberRow {
  user_id: string;
  team_id: string;
  role: 'leader' | 'player';
  starter: boolean;
  joined_at: string;
}

const TEAM_COLUMNS = 'id, name, tag, description, color, logo_url, banner_url, socials, owner_id, points, wins, losses, created_at, disbanded_at';
const teamUrl = (id: string) => `/cod/equipes/${id}`;

function badInput(error: unknown): never {
  if (error instanceof TeamInputError) throw new HttpError(400, 'INVALID_TEAM', error.message);
  throw error;
}

// --- Lecture -------------------------------------------------------------------------

/** Joueurs (pseudo, avatar, points du classé) par identifiant. */
async function playersById(ids: string[]) {
  if (ids.length === 0) return new Map<string, { id: string; username: string; avatar_url: string | null; points: number }>();
  const [users, profiles] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').in('id', ids),
    supabase.from('cod_profiles').select('user_id, points').in('user_id', ids),
  ]);
  if (users.error) throw fromDbError(users.error);
  if (profiles.error) throw fromDbError(profiles.error);
  const points = new Map(((profiles.data ?? []) as { user_id: string; points: number }[]).map((row) => [row.user_id, row.points]));
  return new Map(
    ((users.data ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((user) => [user.id, { ...user, points: points.get(user.id) ?? 0 }]),
  );
}

/** Classement des équipes actives (points, puis victoires, puis ancienneté). */
async function activeTeams(): Promise<TeamRow[]> {
  return (unwrap(
    await supabase
      .from('teams')
      .select(TEAM_COLUMNS)
      .is('disbanded_at', null)
      .order('points', { ascending: false })
      .order('wins', { ascending: false })
      .order('created_at', { ascending: true }),
  ) ?? []) as TeamRow[];
}

export async function listTeams() {
  const teams = await activeTeams();
  const { data, error } = await supabase.from('team_members').select('team_id');
  if (error) throw fromDbError(error);
  const sizes = new Map<string, number>();
  for (const row of (data ?? []) as { team_id: string }[]) sizes.set(row.team_id, (sizes.get(row.team_id) ?? 0) + 1);
  return teams.map((team, index) => ({ ...publicTeam(team), position: index + 1, size: sizes.get(team.id) ?? 0 }));
}

function publicTeam(team: TeamRow) {
  return {
    id: team.id,
    name: team.name,
    tag: team.tag,
    description: team.description,
    color: team.color,
    logoUrl: team.logo_url,
    bannerUrl: team.banner_url,
    socials: team.socials ?? {},
    ownerId: team.owner_id,
    points: team.points,
    wins: team.wins,
    losses: team.losses,
    played: team.wins + team.losses,
    createdAt: team.created_at,
    disbanded: Boolean(team.disbanded_at),
  };
}

async function teamRow(teamId: string): Promise<TeamRow> {
  const team = unwrap(await supabase.from('teams').select(TEAM_COLUMNS).eq('id', teamId).maybeSingle()) as TeamRow | null;
  if (!team) throw new HttpError(404, 'TEAM_NOT_FOUND', 'Équipe introuvable.');
  return team;
}

async function membersOf(teamId: string): Promise<MemberRow[]> {
  return (unwrap(await supabase.from('team_members').select('user_id, team_id, role, starter, joined_at').eq('team_id', teamId).order('joined_at')) ??
    []) as MemberRow[];
}

/** Fiche publique d'une équipe : effectif (titulaires d'abord), place au classement. */
export async function getTeam(teamId: string) {
  const team = await teamRow(teamId);
  const members = await membersOf(teamId);
  const players = await playersById(members.map((member) => member.user_id));
  let position: number | null = null;
  if (!team.disbanded_at) {
    const { count, error } = await supabase
      .from('teams')
      .select('id', { count: 'exact', head: true })
      .is('disbanded_at', null)
      .gt('points', team.points);
    if (error) throw fromDbError(error);
    position = (count ?? 0) + 1;
  }
  return {
    ...publicTeam(team),
    position,
    members: members
      .map((member) => ({
        id: member.user_id,
        username: players.get(member.user_id)?.username ?? 'Joueur',
        avatarUrl: players.get(member.user_id)?.avatar_url ?? null,
        points: players.get(member.user_id)?.points ?? 0,
        role: member.role,
        crown: member.user_id === team.owner_id,
        starter: member.starter,
        joinedAt: member.joined_at,
      }))
      .sort((a, b) => Number(b.starter) - Number(a.starter) || Number(b.crown) - Number(a.crown) || (a.role === b.role ? 0 : a.role === 'leader' ? -1 : 1)),
  };
}

// --- Accès ---------------------------------------------------------------------------

export async function membershipOf(userId: string): Promise<(MemberRow & { isOwner: boolean }) | null> {
  const member = unwrap(await supabase.from('team_members').select('user_id, team_id, role, starter, joined_at').eq('user_id', userId).maybeSingle()) as MemberRow | null;
  if (!member) return null;
  const team = unwrap(await supabase.from('teams').select('owner_id').eq('id', member.team_id).single()) as { owner_id: string };
  return { ...member, isOwner: team.owner_id === userId };
}

/** Matchs classés terminés (la file 1v1 de test n'est pas comptée). */
async function rankedMatchesOf(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('cod_matches')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'completed')
    .or(`team_a.cs.{${userId}},team_b.cs.{${userId}}`)
    .or('format.is.null,format.neq.1v1');
  if (error) throw fromDbError(error);
  return count ?? 0;
}

async function requirementsOf(userId: string, { ignoreTeam = false } = {}) {
  const [user, profile, member, rankedMatches] = await Promise.all([
    supabase.from('users').select('discord_id').eq('id', userId).maybeSingle(),
    supabase.from('cod_profiles').select('activision_id, banned_until, team_left_at').eq('user_id', userId).maybeSingle(),
    supabase.from('team_members').select('team_id').eq('user_id', userId).maybeSingle(),
    rankedMatchesOf(userId),
  ]);
  const p = (profile.data ?? {}) as { activision_id?: string | null; banned_until?: string | null; team_left_at?: string | null };
  const input = {
    rankedMatches,
    activisionId: p.activision_id ?? null,
    discordId: (user.data as { discord_id?: string | null } | null)?.discord_id ?? null,
    bannedUntil: p.banned_until ?? null,
    teamLeftAt: p.team_left_at ?? null,
    inTeam: !ignoreTeam && Boolean(member.data),
  };
  return { missing: missingRequirements(input), rankedMatches, cooldownEnds: leaveCooldownEnd(input.teamLeftAt) };
}

async function assertEligible(userId: string, who = 'Tu'): Promise<void> {
  const { missing } = await requirementsOf(userId);
  if (missing.length > 0) {
    const message = who === 'Tu' ? missing[0]! : `${who} ne remplit pas les conditions pour rejoindre une équipe.`;
    throw new HttpError(403, 'TEAM_REQUIREMENTS', message);
  }
}

/** Membre de cette équipe, avec ses droits ; sinon 403. */
async function actorIn(teamId: string, userId: string): Promise<TeamActor & MemberRow> {
  const member = await membershipOf(userId);
  if (!member || member.team_id !== teamId) throw new HttpError(403, 'NOT_IN_TEAM', 'Tu ne fais pas partie de cette équipe.');
  return member;
}

function forbid(message = 'Seul un Leader peut faire cela.'): never {
  throw new HttpError(403, 'TEAM_FORBIDDEN', message);
}

// --- Mon équipe ------------------------------------------------------------------------

/** Tout ce que la page « Mon équipe » affiche pour ce joueur. */
export async function myTeamState(userId: string) {
  const member = await membershipOf(userId);
  const requirements = await requirementsOf(userId, { ignoreTeam: true });
  const base = { requirements: { missing: requirements.missing, rankedMatches: requirements.rankedMatches, needed: TEAM_LIMITS.minRankedMatches, cooldownEnds: requirements.cooldownEnds } };

  if (!member) {
    const rows = (unwrap(
      await supabase.from('team_invites').select('id, team_id, kind, created_by, created_at').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }),
    ) ?? []) as { id: number; team_id: string; kind: 'invite' | 'request'; created_by: string; created_at: string }[];
    const teams = rows.length
      ? ((unwrap(await supabase.from('teams').select(TEAM_COLUMNS).in('id', [...new Set(rows.map((row) => row.team_id))])) ?? []) as TeamRow[])
      : [];
    const byId = new Map(teams.map((team) => [team.id, publicTeam(team)]));
    const withTeam = rows.filter((row) => byId.has(row.team_id)).map((row) => ({ id: row.id, kind: row.kind, createdAt: row.created_at, team: byId.get(row.team_id)! }));
    return { ...base, team: null, invites: withTeam.filter((row) => row.kind === 'invite'), requests: withTeam.filter((row) => row.kind === 'request') };
  }

  const team = await getTeam(member.team_id);
  const actor: TeamActor = { role: member.role, isOwner: member.isOwner };
  let pending: { id: number; kind: string; createdAt: string; player: { id: string; username: string; avatarUrl: string | null; points: number; rankedMatches?: number } }[] = [];
  if (canDo(actor, 'invite')) {
    const rows = (unwrap(
      await supabase.from('team_invites').select('id, user_id, kind, created_at').eq('team_id', member.team_id).eq('status', 'pending').order('created_at', { ascending: false }),
    ) ?? []) as { id: number; user_id: string; kind: string; created_at: string }[];
    const players = await playersById(rows.map((row) => row.user_id));
    pending = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        player: {
          id: row.user_id,
          username: players.get(row.user_id)?.username ?? 'Joueur',
          avatarUrl: players.get(row.user_id)?.avatar_url ?? null,
          points: players.get(row.user_id)?.points ?? 0,
          rankedMatches: row.kind === 'request' ? await rankedMatchesOf(row.user_id) : undefined,
        },
      })),
    );
  }
  return {
    ...base,
    team,
    me: { role: member.role, crown: member.isOwner, starter: member.starter },
    sentInvites: pending.filter((row) => row.kind === 'invite'),
    joinRequests: pending.filter((row) => row.kind === 'request'),
  };
}

// --- Création et fiche -------------------------------------------------------------------

export async function createTeam(userId: string, body: unknown) {
  await assertEligible(userId);
  let input;
  try {
    input = parseTeamInput(body, { create: true });
  } catch (error) {
    badInput(error);
  }
  const team = unwrap(
    await supabase.rpc('team_create', { p_owner: userId, p_name: input.name, p_tag: input.tag, p_description: input.description ?? null, p_color: input.color }),
  ) as TeamRow;
  return getTeam(team.id);
}

export async function updateTeam(userId: string, teamId: string, body: unknown) {
  const actor = await actorIn(teamId, userId);
  if (!canDo(actor, 'edit')) forbid();
  let input;
  try {
    input = parseTeamInput(body);
  } catch (error) {
    badInput(error);
  }
  if ((input.name !== undefined || input.tag !== undefined) && !canDo(actor, 'rename')) forbid('Seul le Leader à la couronne peut renommer l’équipe.');

  const patch: Record<string, unknown> = { ...input };
  const raw = (body ?? {}) as { logoUrl?: unknown; bannerUrl?: unknown };
  for (const [key, column] of [['logoUrl', 'logo_url'], ['bannerUrl', 'banner_url']] as const) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null) patch[column] = null;
    else if (isOwnTeamMedia(raw[key], config.supabaseUrl, userId)) patch[column] = raw[key];
    else throw new HttpError(400, 'INVALID_TEAM', 'Image invalide : envoie-la depuis le site.');
  }
  if (Object.keys(patch).length === 0) return getTeam(teamId);

  if (input.name !== undefined || input.tag !== undefined) {
    const rows = (unwrap(await supabase.from('teams').select('name, tag').is('disbanded_at', null).neq('id', teamId)) ?? []) as { name: string; tag: string }[];
    if (rows.some((row) => input.name !== undefined && row.name.toLowerCase() === input.name.toLowerCase())) throw new HttpError(409, 'TEAM_NAME_TAKEN', 'Ce nom d’équipe est déjà pris.');
    if (rows.some((row) => row.tag === input.tag)) throw new HttpError(409, 'TEAM_TAG_TAKEN', 'Ce tag est déjà pris.');
  }
  unwrap(await supabase.from('teams').update(patch).eq('id', teamId).is('disbanded_at', null));
  return getTeam(teamId);
}

// --- Invitations et candidatures ---------------------------------------------------------

/** Recherche de joueurs à inviter (pseudo ou identifiant Activision, pseudos stylisés compris). */
export async function searchInvitable(userId: string, teamId: string, query: unknown) {
  const actor = await actorIn(teamId, userId);
  if (!canDo(actor, 'invite')) forbid();
  const q = typeof query === 'string' ? query.slice(0, 40) : '';
  if (q.trim().length < 2) return [];
  const [users, profiles, members] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url'),
    supabase.from('cod_profiles').select('user_id, activision_id, points'),
    supabase.from('team_members').select('user_id'),
  ]);
  if (users.error) throw fromDbError(users.error);
  const inTeam = new Set(((members.data ?? []) as { user_id: string }[]).map((row) => row.user_id));
  const profileById = new Map(((profiles.data ?? []) as { user_id: string; activision_id: string | null; points: number }[]).map((row) => [row.user_id, row]));
  const candidates = ((users.data ?? []) as { id: string; username: string; avatar_url: string | null }[])
    .filter((user) => !inTeam.has(user.id))
    .map((user) => ({ id: user.id, username: user.username, avatarUrl: user.avatar_url, activisionId: profileById.get(user.id)?.activision_id ?? null, points: profileById.get(user.id)?.points ?? 0 }));
  return rankPlayers(candidates, q)
    .slice(0, 8)
    .map(({ id, username, avatarUrl, points }) => ({ id, username, avatarUrl, points }));
}

async function pendingCount(teamId: string): Promise<number> {
  const { count, error } = await supabase.from('team_invites').select('id', { count: 'exact', head: true }).eq('team_id', teamId).eq('status', 'pending');
  if (error) throw fromDbError(error);
  return count ?? 0;
}

async function existingPending(teamId: string, targetId: string) {
  return unwrap(await supabase.from('team_invites').select('id, kind').eq('team_id', teamId).eq('user_id', targetId).eq('status', 'pending').maybeSingle()) as {
    id: number;
    kind: 'invite' | 'request';
  } | null;
}

async function leadersOf(teamId: string): Promise<string[]> {
  const team = await teamRow(teamId);
  const rows = (unwrap(await supabase.from('team_members').select('user_id').eq('team_id', teamId).eq('role', 'leader')) ?? []) as { user_id: string }[];
  return [...new Set([team.owner_id, ...rows.map((row) => row.user_id)])];
}

export async function invitePlayer(userId: string, teamId: string, body: unknown) {
  const actor = await actorIn(teamId, userId);
  if (!canDo(actor, 'invite')) forbid();
  const targetId = (body as { userId?: unknown } | undefined)?.userId;
  if (typeof targetId !== 'string' || !/^[0-9a-f-]{36}$/i.test(targetId)) throw new HttpError(400, 'INVALID_TARGET', 'Joueur invalide.');
  if (targetId === userId) throw new HttpError(400, 'INVALID_TARGET', 'Tu fais déjà partie de l’équipe.');

  const team = await teamRow(teamId);
  const members = await membersOf(teamId);
  if (members.length >= TEAM_LIMITS.maxMembers) throw new HttpError(409, 'TEAM_FULL', 'L’équipe est complète (8 joueurs).');
  const target = unwrap(await supabase.from('users').select('id, username').eq('id', targetId).maybeSingle()) as { id: string; username: string } | null;
  if (!target) throw new HttpError(404, 'PLAYER_NOT_FOUND', 'Joueur introuvable.');
  await assertEligible(targetId, target.username);

  const pending = await existingPending(teamId, targetId);
  if (pending?.kind === 'request') return answerInvite(userId, pending.id, { accept: true });
  if (pending) throw new HttpError(409, 'ALREADY_INVITED', `${target.username} a déjà une invitation en attente.`);
  if ((await pendingCount(teamId)) >= TEAM_LIMITS.maxPendingInvites) throw new HttpError(409, 'TOO_MANY_INVITES', 'Trop d’invitations en attente : annule-en avant d’en envoyer d’autres.');

  unwrap(await supabase.from('team_invites').insert({ team_id: teamId, user_id: targetId, kind: 'invite', created_by: userId }));
  await pushToUsers([targetId], { title: `🛡️ Invitation de ${team.name}`, body: `[${team.tag}] t’invite à rejoindre son équipe.`, url: '/cod/equipe', tag: `equipe-${teamId}` });
  if (discordEnabled) await dm([targetId], `**[${team.tag}] ${team.name}** t’invite à rejoindre son équipe sur SixSence : ${config.siteUrl}/cod/equipe`);
  return { ok: true };
}

export async function requestToJoin(userId: string, teamId: string) {
  await assertEligible(userId);
  const team = await teamRow(teamId);
  if (team.disbanded_at) throw new HttpError(404, 'TEAM_NOT_FOUND', 'Équipe introuvable.');
  if ((await membersOf(teamId)).length >= TEAM_LIMITS.maxMembers) throw new HttpError(409, 'TEAM_FULL', 'L’équipe est complète (8 joueurs).');

  const pending = await existingPending(teamId, userId);
  if (pending?.kind === 'invite') return answerInvite(userId, pending.id, { accept: true });
  if (pending) throw new HttpError(409, 'ALREADY_REQUESTED', 'Ta candidature est déjà envoyée.');
  if ((await pendingCount(teamId)) >= TEAM_LIMITS.maxPendingInvites) throw new HttpError(409, 'TOO_MANY_INVITES', 'Cette équipe a trop de candidatures en attente.');

  unwrap(await supabase.from('team_invites').insert({ team_id: teamId, user_id: userId, kind: 'request', created_by: userId }));
  const username = (unwrap(await supabase.from('users').select('username').eq('id', userId).single()) as { username: string }).username;
  await pushToUsers(await leadersOf(teamId), { title: '🛡️ Nouvelle candidature', body: `${username} veut rejoindre ${team.name}.`, url: '/cod/equipe', tag: `candidature-${teamId}` });
  return { ok: true };
}

/** Répondre : le joueur invité (invitation) ou un Leader de l'équipe (candidature). */
export async function answerInvite(userId: string, inviteId: unknown, body: unknown) {
  const id = Number(inviteId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'INVALID_ID', 'Identifiant invalide.');
  const accept = (body as { accept?: unknown } | undefined)?.accept === true;
  const invite = unwrap(await supabase.from('team_invites').select('id, team_id, user_id, kind, status').eq('id', id).maybeSingle()) as {
    id: number;
    team_id: string;
    user_id: string;
    kind: 'invite' | 'request';
    status: string;
  } | null;
  if (!invite || invite.status !== 'pending') throw new HttpError(404, 'INVITE_NOT_FOUND', 'Cette invitation n’est plus valable.');

  if (invite.kind === 'invite') {
    if (invite.user_id !== userId) forbid('Cette invitation ne t’est pas adressée.');
  } else {
    const actor = await actorIn(invite.team_id, userId);
    if (!canDo(actor, 'answerRequest')) forbid();
  }

  if (!accept) {
    unwrap(await supabase.from('team_invites').update({ status: 'declined', answered_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending'));
    return { ok: true };
  }

  const joiner = unwrap(await supabase.from('users').select('username').eq('id', invite.user_id).single()) as { username: string };
  await assertEligible(invite.user_id, invite.kind === 'invite' ? 'Tu' : joiner.username);
  unwrap(await supabase.rpc('team_add_member', { p_team: invite.team_id, p_user: invite.user_id }));
  unwrap(await supabase.from('team_invites').update({ status: 'accepted', answered_at: new Date().toISOString() }).eq('id', id));

  const team = await teamRow(invite.team_id);
  if (invite.kind === 'request') {
    await pushToUsers([invite.user_id], { title: `✅ Bienvenue dans ${team.name}`, body: 'Ta candidature a été acceptée.', url: teamUrl(team.id), tag: `equipe-${team.id}` });
    if (discordEnabled) await dm([invite.user_id], `✅ Ta candidature chez **[${team.tag}] ${team.name}** a été acceptée : ${config.siteUrl}${teamUrl(team.id)}`);
  } else {
    await pushToUsers(await leadersOf(team.id), { title: `✅ ${joiner.username} a rejoint ${team.name}`, body: 'Invitation acceptée.', url: '/cod/equipe', tag: `equipe-${team.id}` });
  }
  return { ok: true, teamId: team.id };
}

/** Annuler : une invitation (par un Leader) ou sa propre candidature. */
export async function cancelInvite(userId: string, inviteId: unknown) {
  const id = Number(inviteId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'INVALID_ID', 'Identifiant invalide.');
  const invite = unwrap(await supabase.from('team_invites').select('id, team_id, user_id, kind, status').eq('id', id).maybeSingle()) as {
    team_id: string;
    user_id: string;
    kind: string;
    status: string;
  } | null;
  if (!invite || invite.status !== 'pending') throw new HttpError(404, 'INVITE_NOT_FOUND', 'Cette invitation n’est plus valable.');
  if (invite.kind === 'request') {
    if (invite.user_id !== userId) forbid();
  } else if (!canDo(await actorIn(invite.team_id, userId), 'invite')) forbid();
  unwrap(await supabase.from('team_invites').update({ status: 'cancelled', answered_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending'));
  return { ok: true };
}

/** Effectif modifié : l'équipe sort de la file des matchs (ses titulaires ne sont peut-être plus là). */
async function leaveQueueOnChange(teamId: string): Promise<void> {
  await supabase.from('team_queue').delete().eq('team_id', teamId);
}

// --- Effectif ---------------------------------------------------------------------------

async function targetIn(teamId: string, targetId: string): Promise<TeamActor> {
  const target = await membershipOf(targetId);
  if (!target || target.team_id !== teamId) throw new HttpError(404, 'NOT_IN_TEAM', 'Ce joueur ne fait pas partie de l’équipe.');
  return target;
}

/** Titulaire / remplaçant (Leader) ; Leader / Joueur (couronne). */
export async function updateMember(userId: string, teamId: string, targetId: string, body: unknown) {
  const actor = await actorIn(teamId, userId);
  const target = await targetIn(teamId, targetId);
  const input = (body ?? {}) as { role?: unknown; starter?: unknown };
  if (input.role !== undefined) {
    if (input.role !== 'leader' && input.role !== 'player') throw new HttpError(400, 'INVALID_ROLE', 'Rôle inconnu.');
    if (!canDo(actor, 'setRole', target)) forbid('Seul le Leader à la couronne nomme les Leaders.');
    unwrap(await supabase.from('team_members').update({ role: input.role }).eq('team_id', teamId).eq('user_id', targetId));
  }
  if (input.starter !== undefined) {
    if (typeof input.starter !== 'boolean') throw new HttpError(400, 'INVALID_ROLE', 'Valeur invalide.');
    if (!canDo(actor, 'setStarter')) forbid();
    unwrap(await supabase.rpc('team_set_starter', { p_team: teamId, p_user: targetId, p_starter: input.starter }));
  }
  return getTeam(teamId);
}

export async function kickMember(userId: string, teamId: string, targetId: string) {
  const actor = await actorIn(teamId, userId);
  const target = await targetIn(teamId, targetId);
  if (!canDo(actor, 'kick', target)) forbid(target.isOwner ? 'Le Leader à la couronne ne peut pas être exclu.' : 'Seul le Leader à la couronne peut exclure un Leader.');
  unwrap(await supabase.rpc('team_remove_member', { p_team: teamId, p_user: targetId, p_left: false }));
  await leaveQueueOnChange(teamId);
  const team = await teamRow(teamId);
  await pushToUsers([targetId], { title: `Tu ne fais plus partie de ${team.name}`, body: 'Un Leader t’a retiré de l’équipe.', url: '/cod/equipe', tag: `equipe-${teamId}` });
  return getTeam(teamId);
}

/** Quitter son équipe (24 h avant d'en rejoindre une autre). Seul membre restant : l'équipe est dissoute. */
export async function leaveTeam(userId: string) {
  const member = await membershipOf(userId);
  if (!member) throw new HttpError(409, 'NOT_IN_TEAM', 'Tu ne fais partie d’aucune équipe.');
  unwrap(await supabase.rpc('team_remove_member', { p_team: member.team_id, p_user: userId, p_left: true }));
  await leaveQueueOnChange(member.team_id);
  return { ok: true };
}

export async function transferCrown(userId: string, teamId: string, body: unknown) {
  const targetId = (body as { userId?: unknown } | undefined)?.userId;
  if (typeof targetId !== 'string') throw new HttpError(400, 'INVALID_TARGET', 'Joueur invalide.');
  const actor = await actorIn(teamId, userId);
  if (!canDo(actor, 'transfer')) forbid('Seul le Leader à la couronne peut la transmettre.');
  unwrap(await supabase.rpc('team_transfer', { p_team: teamId, p_owner: userId, p_target: targetId }));
  const team = await teamRow(teamId);
  await pushToUsers([targetId], { title: `👑 Tu portes la couronne de ${team.name}`, body: 'Tu gères maintenant l’équipe.', url: '/cod/equipe', tag: `equipe-${teamId}` });
  return getTeam(teamId);
}

export async function disbandTeam(userId: string, teamId: string) {
  const actor = await actorIn(teamId, userId);
  if (!canDo(actor, 'disband')) forbid('Seul le Leader à la couronne peut dissoudre l’équipe.');
  const members = (await membersOf(teamId)).map((member) => member.user_id).filter((id) => id !== userId);
  const team = await teamRow(teamId);
  unwrap(await supabase.rpc('team_disband', { p_team: teamId }));
  await leaveQueueOnChange(teamId);
  await pushToUsers(members, { title: `${team.name} a été dissoute`, body: 'Tu peux rejoindre une autre équipe.', url: '/cod/equipes', tag: `equipe-${teamId}` });
  return { ok: true };
}

// --- Signalement ------------------------------------------------------------------------

export async function reportTeam(userId: string, teamId: string, body: unknown) {
  const input = (body ?? {}) as { reason?: unknown; details?: unknown };
  if (typeof input.reason !== 'string' || !TEAM_REPORT_REASONS[input.reason]) throw new HttpError(400, 'INVALID_REASON', 'Choisis un motif.');
  const details = typeof input.details === 'string' ? input.details.trim().slice(0, 500) || null : null;
  const team = await teamRow(teamId);
  const { count, error } = await supabase
    .from('team_reports')
    .select('id', { count: 'exact', head: true })
    .eq('reporter_id', userId)
    .eq('team_id', teamId)
    .eq('status', 'open');
  if (error) throw fromDbError(error);
  if ((count ?? 0) > 0) throw new HttpError(409, 'ALREADY_REPORTED', 'Tu as déjà signalé cette équipe : l’équipe SixSence va examiner ton signalement.');
  unwrap(await supabase.from('team_reports').insert({ team_id: teamId, reporter_id: userId, reason: input.reason, details }));
  await notifyStaff(`⚑ Équipe signalée : **[${team.tag}] ${team.name}** — ${TEAM_REPORT_REASONS[input.reason]}${details ? ` : ${details}` : ''}\n${config.siteUrl}${teamUrl(teamId)}`);
  return { ok: true };
}

// --- Administration (staff et admins) ------------------------------------------------------

const countBy = (rows: { team_id: string }[]) => rows.reduce((map, row) => map.set(row.team_id, (map.get(row.team_id) ?? 0) + 1), new Map<string, number>());

/** Équipes actives pour l'onglet admin « Équipes » (recherche par nom ou tag), signalées d'abord. */
export async function adminTeams(query: unknown) {
  const q = typeof query === 'string' ? query.trim().toLowerCase().slice(0, 40) : '';
  const [teams, members, reports] = await Promise.all([
    activeTeams(),
    supabase.from('team_members').select('team_id'),
    supabase.from('team_reports').select('team_id').eq('status', 'open'),
  ]);
  if (members.error) throw fromDbError(members.error);
  if (reports.error) throw fromDbError(reports.error);
  const sizes = countBy((members.data ?? []) as { team_id: string }[]);
  const open = countBy((reports.data ?? []) as { team_id: string }[]);
  const owners = await playersById([...new Set(teams.map((team) => team.owner_id))]);
  return teams
    .map((team, index) => ({
      ...publicTeam(team),
      position: index + 1,
      size: sizes.get(team.id) ?? 0,
      openReports: open.get(team.id) ?? 0,
      crown: owners.get(team.owner_id)?.username ?? 'Joueur',
    }))
    .filter((team) => !q || team.name.toLowerCase().includes(q) || team.tag.toLowerCase().includes(q))
    .sort((a, b) => b.openReports - a.openReports || a.position - b.position);
}

/** Signalements d'équipes (les plus récents d'abord), avec l'équipe et l'auteur. */
export async function adminTeamReports(status: unknown) {
  let request = supabase
    .from('team_reports')
    .select('id, team_id, reporter_id, reason, details, status, created_at, resolved_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (status === 'open' || status === 'resolved' || status === 'rejected') request = request.eq('status', status);
  const rows = (unwrap(await request) ?? []) as {
    id: number;
    team_id: string;
    reporter_id: string;
    reason: string;
    details: string | null;
    status: string;
    created_at: string;
    resolved_at: string | null;
  }[];
  const teams = rows.length ? ((unwrap(await supabase.from('teams').select(TEAM_COLUMNS).in('id', [...new Set(rows.map((row) => row.team_id))])) ?? []) as TeamRow[]) : [];
  const teamById = new Map(teams.map((team) => [team.id, publicTeam(team)]));
  const reporters = await playersById([...new Set(rows.map((row) => row.reporter_id))]);
  return rows.map((row) => ({
    id: row.id,
    reason: row.reason,
    reasonLabel: TEAM_REPORT_REASONS[row.reason] ?? row.reason,
    details: row.details,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    team: teamById.get(row.team_id) ?? null,
    reporter: reporters.get(row.reporter_id)?.username ?? 'Joueur',
  }));
}

export async function closeTeamReport(staffId: string, reportId: unknown, body: unknown) {
  const id = Number(reportId);
  const status = (body as { status?: unknown } | undefined)?.status;
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'INVALID_ID', 'Identifiant invalide.');
  if (status !== 'resolved' && status !== 'rejected') throw new HttpError(400, 'INVALID_STATUS', 'Statut invalide.');
  const row = unwrap(
    await supabase
      .from('team_reports')
      .update({ status, resolved_by: staffId, resolved_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'open')
      .select('id')
      .maybeSingle(),
  );
  if (!row) throw new HttpError(404, 'REPORT_NOT_FOUND', 'Signalement introuvable ou déjà traité.');
  return { ok: true };
}

async function resolveTeamReports(teamId: string, staffId: string): Promise<void> {
  unwrap(
    await supabase
      .from('team_reports')
      .update({ status: 'resolved', resolved_by: staffId, resolved_at: new Date().toISOString() })
      .eq('team_id', teamId)
      .eq('status', 'open'),
  );
}

/**
 * Modération d'une fiche : retirer le logo, la bannière ou la description, renommer (nom et tag).
 * Les signalements ouverts de l'équipe sont classés « traités » et ses Leaders prévenus.
 */
export async function moderateTeam(staffId: string, teamId: string, body: unknown) {
  const input = (body ?? {}) as { clearLogo?: unknown; clearBanner?: unknown; clearDescription?: unknown; name?: unknown; tag?: unknown };
  const team = await teamRow(teamId);
  if (team.disbanded_at) throw new HttpError(404, 'TEAM_NOT_FOUND', 'Équipe introuvable.');
  const patch: Record<string, unknown> = {};
  if (input.clearLogo === true) patch.logo_url = null;
  if (input.clearBanner === true) patch.banner_url = null;
  if (input.clearDescription === true) patch.description = null;
  if (input.name !== undefined || input.tag !== undefined) {
    let parsed: { name?: string; tag?: string } = {};
    try {
      parsed = parseTeamInput({ name: input.name ?? team.name, tag: input.tag ?? team.tag }, { create: true });
    } catch (error) {
      badInput(error);
    }
    const rows = (unwrap(await supabase.from('teams').select('name, tag').is('disbanded_at', null).neq('id', teamId)) ?? []) as { name: string; tag: string }[];
    if (rows.some((row) => row.name.toLowerCase() === parsed.name!.toLowerCase())) throw new HttpError(409, 'TEAM_NAME_TAKEN', 'Ce nom d’équipe est déjà pris.');
    if (rows.some((row) => row.tag === parsed.tag)) throw new HttpError(409, 'TEAM_TAG_TAKEN', 'Ce tag est déjà pris.');
    patch.name = parsed.name;
    patch.tag = parsed.tag;
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'INVALID_TEAM', 'Rien à modifier.');
  unwrap(await supabase.from('teams').update(patch).eq('id', teamId));
  await resolveTeamReports(teamId, staffId);
  await pushToUsers(await leadersOf(teamId), {
    title: `Fiche de ${team.name} modérée`,
    body: 'L’équipe SixSence a modifié la fiche de ton équipe (contenu inapproprié).',
    url: '/cod/equipe',
    tag: `equipe-${teamId}`,
  });
  return getTeam(teamId);
}

/** Dissolution par l'équipe SixSence : effectif libéré, signalements classés, joueurs prévenus. */
export async function adminDisbandTeam(staffId: string, teamId: string) {
  const team = await teamRow(teamId);
  const members = (await membersOf(teamId)).map((member) => member.user_id);
  unwrap(await supabase.rpc('team_disband', { p_team: teamId }));
  await leaveQueueOnChange(teamId);
  await resolveTeamReports(teamId, staffId);
  await pushToUsers(members, {
    title: `${team.name} a été dissoute`,
    body: 'L’équipe SixSence a dissous ton équipe. Tu peux en rejoindre une autre.',
    url: '/cod/equipes',
    tag: `equipe-${teamId}`,
  });
  return { ok: true };
}
