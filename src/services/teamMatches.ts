import { isReferee, roleOf } from '../auth.js';
import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { SUPPRESS_EMBEDS, discord, discordEnabled, dm, notifyStaff } from './discord.js';
import { correctionWindowHours, withinWindow } from './correctionPolicy.js';
import { pushToUsers } from './push.js';
import { deciderPicker, declarationError, isCompleteSeries, pickMaps, seriesState, type MapScore, type Side } from './teamMatchPolicy.js';
import { membershipOf } from './teams.js';

/**
 * Matchs d'équipe (Division, étape 2) : file des équipes, BO3, déclaration et
 * confirmation des scores par les Leaders, choix de la map 3, arbitrage, ménage et Discord.
 * Règles pures dans teamMatchPolicy.ts ; création et clôture atomiques en SQL (migration 0026).
 */

export interface TeamMatch {
  id: string;
  season_id: number | null;
  team_a: string;
  team_b: string;
  roster_a: string[];
  roster_b: string[];
  points_a: number;
  points_b: number;
  stakes: Record<Side, { win: number; loss: number }>;
  mode: string;
  maps: { map: string; pick: Side | 'random' }[];
  scores: MapScore[];
  map3_picker: Side | 'random' | null;
  status: 'in_progress' | 'awaiting_confirmation' | 'disputed' | 'completed' | 'cancelled';
  pending_scores: MapScore[] | null;
  reported_by: string | null;
  reported_team: Side | null;
  reported_at: string | null;
  winner: Side | null;
  points_changes: Partial<Record<Side, number>>;
  cancel_reason: string | null;
  discord_channels: Record<string, string>;
  discord_done: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** Match de tournoi (pas de points en jeu), tour du tableau, format (3, ou 5 en finale). */
  tournament_id: string | null;
  round: number | null;
  best_of: number;
  /** Correction après validation (0029). */
  corrected_at: string | null;
  correction_reason: string | null;
}

const OPEN = ['in_progress', 'awaiting_confirmation', 'disputed'];
const matchUrl = (id: string) => `/cod/equipes/match/${id}`;
const other = (side: Side): Side => (side === 'A' ? 'B' : 'A');

async function matchRow(matchId: string): Promise<TeamMatch> {
  const match = unwrap(await supabase.from('team_matches').select('*').eq('id', matchId).maybeSingle()) as TeamMatch | null;
  if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');
  return match;
}

async function teamsById(ids: string[]) {
  const rows = (unwrap(await supabase.from('teams').select('id, name, tag, color, logo_url, owner_id, points').in('id', ids)) ?? []) as {
    id: string;
    name: string;
    tag: string;
    color: string;
    logo_url: string | null;
    owner_id: string;
    points: number;
  }[];
  return new Map(rows.map((team) => [team.id, team]));
}

/** Leaders d'une équipe (couronne comprise). */
async function leadersOf(teamId: string): Promise<string[]> {
  const [team, rows] = await Promise.all([
    supabase.from('teams').select('owner_id').eq('id', teamId).single(),
    supabase.from('team_members').select('user_id').eq('team_id', teamId).eq('role', 'leader'),
  ]);
  return [...new Set([(team.data as { owner_id: string } | null)?.owner_id, ...((rows.data ?? []) as { user_id: string }[]).map((row) => row.user_id)].filter(Boolean) as string[])];
}

/** Côté (A ou B) dont ce joueur est Leader dans ce match, ou null. */
async function leaderSide(match: TeamMatch, userId: string): Promise<Side | null> {
  const member = await membershipOf(userId);
  if (!member || !(member.role === 'leader' || member.isOwner)) return null;
  return member.team_id === match.team_a ? 'A' : member.team_id === match.team_b ? 'B' : null;
}

// --- File des équipes ----------------------------------------------------------------------

/** État « jouer » de l'équipe du joueur : recherche en cours, match en cours, équipes en file. */
export async function teamPlayState(userId: string) {
  const member = await membershipOf(userId);
  const queueCount = await supabase.from('team_queue').select('team_id', { count: 'exact', head: true });
  const base = { rosterSize: config.teams.rosterSize, teamsSearching: queueCount.count ?? 0 };
  if (!member) return { ...base, queued: null, activeMatchId: null };
  const [queued, active] = await Promise.all([
    supabase.from('team_queue').select('roster, joined_at').eq('team_id', member.team_id).maybeSingle(),
    supabase.from('team_matches').select('id').in('status', OPEN).or(`team_a.eq.${member.team_id},team_b.eq.${member.team_id}`).limit(1).maybeSingle(),
  ]);
  const q = queued.data as { roster: string[]; joined_at: string } | null;
  return { ...base, queued: q ? { roster: q.roster, since: q.joined_at } : null, activeMatchId: (active.data as { id: string } | null)?.id ?? null };
}

/** Le Leader inscrit son équipe avec ses titulaires (TEAM_MATCH_PLAYERS joueurs de l'équipe). */
export async function joinTeamQueue(userId: string, body: unknown) {
  const member = await membershipOf(userId);
  if (!member) throw new HttpError(409, 'NOT_IN_TEAM', 'Tu ne fais partie d’aucune équipe.');
  if (!(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut lancer une recherche.');
  const teamId = member.team_id;
  const size = config.teams.rosterSize;

  const roster = (body as { roster?: unknown } | undefined)?.roster;
  if (!Array.isArray(roster) || roster.length !== size || new Set(roster).size !== size || !roster.every((id) => typeof id === 'string')) {
    throw new HttpError(400, 'INVALID_ROSTER', `Choisis ${size} titulaire${size > 1 ? 's' : ''} différent${size > 1 ? 's' : ''}.`);
  }
  const members = (unwrap(await supabase.from('team_members').select('user_id').eq('team_id', teamId)) ?? []) as { user_id: string }[];
  const ids = new Set(members.map((row) => row.user_id));
  if (!roster.every((id) => ids.has(id))) throw new HttpError(400, 'INVALID_ROSTER', 'Les titulaires doivent faire partie de l’équipe.');

  const state = await teamPlayState(userId);
  if (state.activeMatchId) throw new HttpError(409, 'ALREADY_IN_MATCH', 'Ton équipe a déjà un match en cours.');
  const { teamBusyInTournament } = await import('./tournaments.js');
  if (await teamBusyInTournament(teamId)) throw new HttpError(409, 'TEAM_IN_TOURNAMENT', 'Ton équipe est inscrite au tournoi en cours : pas de match ordinaire d’ici la fin de son parcours.');

  // Chaque titulaire : pas d'exclusion, pas de match classé en cours, pas en file classée.
  const [profiles, users, rankedQueue] = await Promise.all([
    supabase.from('cod_profiles').select('user_id, banned_until, activision_id').in('user_id', roster),
    supabase.from('users').select('id, username').in('id', roster),
    supabase.from('cod_queue').select('user_id').in('user_id', roster),
  ]);
  const name = new Map(((users.data ?? []) as { id: string; username: string }[]).map((row) => [row.id, row.username]));
  for (const profile of (profiles.data ?? []) as { user_id: string; banned_until: string | null; activision_id: string | null }[]) {
    if (profile.banned_until && new Date(profile.banned_until).getTime() > Date.now()) throw new HttpError(403, 'MEMBER_BANNED', `${name.get(profile.user_id) ?? 'Un titulaire'} est exclu en ce moment.`);
    if (!profile.activision_id) throw new HttpError(409, 'MEMBER_PROFILE_INCOMPLETE', `${name.get(profile.user_id) ?? 'Un titulaire'} doit renseigner son identifiant Activision.`);
  }
  const inRankedQueue = ((rankedQueue.data ?? []) as { user_id: string }[])[0];
  if (inRankedQueue) throw new HttpError(409, 'MEMBER_IN_QUEUE', `${name.get(inRankedQueue.user_id) ?? 'Un titulaire'} est dans la file classée.`);
  for (const id of roster) {
    const active = unwrap(await supabase.rpc('cod_active_match_id', { p_user: id }));
    if (active) throw new HttpError(409, 'MEMBER_IN_MATCH', `${name.get(id) ?? 'Un titulaire'} a un match classé en cours.`);
  }

  unwrap(await supabase.from('team_queue').upsert({ team_id: teamId, roster, queued_by: userId, joined_at: new Date().toISOString() }));
  await tryCreateTeamMatches();
  return teamPlayState(userId);
}

export async function leaveTeamQueue(userId: string) {
  const member = await membershipOf(userId);
  if (!member || !(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut arrêter la recherche.');
  unwrap(await supabase.from('team_queue').delete().eq('team_id', member.team_id));
  return teamPlayState(userId);
}

/** Crée les matchs tant que deux équipes attendent. */
export async function tryCreateTeamMatches(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    const { data, error } = await supabase.rpc('team_match_create', { p_maps: pickMaps(config.cod.maps, 2), p_mode: config.cod.modes[0] });
    if (error) {
      console.error('[team-match] création impossible', error.message);
      return;
    }
    const match = data as TeamMatch | null;
    if (!match?.id) return;
    await onTeamMatchCreated(match).catch((caught) => console.warn('[team-match] annonce impossible', (caught as Error).message));
  }
}

async function onTeamMatchCreated(match: TeamMatch): Promise<void> {
  const teams = await teamsById([match.team_a, match.team_b]);
  const a = teams.get(match.team_a)!;
  const b = teams.get(match.team_b)!;
  const players = [...match.roster_a, ...match.roster_b];
  await pushToUsers(players, {
    title: `⚔️ Division : [${a.tag}] vs [${b.tag}]`,
    body: `BO3 · ${match.maps.map((map) => map.map).join(' puis ')}. Ouvre la feuille de match.`,
    url: matchUrl(match.id),
    tag: `team-match-${match.id}`,
    urgent: true,
  });
  if (!discordEnabled || !config.teams.discord) return;
  const { guildId, matchCategoryId } = config.discord;
  const created: Record<string, string> = {};
  try {
    for (const [key, team] of [['teamA', a], ['teamB', b]] as const) {
      const channel = (await discord(`/guilds/${guildId}/channels`, {
        method: 'POST',
        body: { name: `[${a.tag}] vs [${b.tag}] · ${team.tag}`, type: 2, user_limit: config.teams.rosterSize + 1, ...(matchCategoryId ? { parent_id: matchCategoryId } : {}) },
      })) as { id: string };
      created[key] = channel.id;
    }
    await supabase.from('team_matches').update({ discord_channels: created }).eq('id', match.id);
    const link = (id: string) => `https://discord.com/channels/${guildId}/${id}`;
    const sheet = `${config.siteUrl}${matchUrl(match.id)}`;
    await dm(match.roster_a, `**Division : [${a.tag}] vs [${b.tag}]** (BO3) — vocal de ton équipe : ${link(created.teamA!)}\nFeuille de match : ${sheet}`);
    await dm(match.roster_b, `**Division : [${a.tag}] vs [${b.tag}]** (BO3) — vocal de ton équipe : ${link(created.teamB!)}\nFeuille de match : ${sheet}`);
  } catch (caught) {
    console.warn('[team-match] salons vocaux impossibles', (caught as Error).message);
    for (const id of Object.values(created)) await discord(`/channels/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}

// --- Feuille de match -------------------------------------------------------------------------

export async function getTeamMatch(matchId: string, viewerId: string | null) {
  const match = await matchRow(matchId);
  const teams = await teamsById([match.team_a, match.team_b]);
  const ids = [...match.roster_a, ...match.roster_b];
  const [users, profiles] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').in('id', ids),
    supabase.from('cod_profiles').select('user_id, points, activision_id').in('user_id', ids),
  ]);
  if (users.error) throw fromDbError(users.error);
  const profileById = new Map(((profiles.data ?? []) as { user_id: string; points: number; activision_id: string | null }[]).map((row) => [row.user_id, row]));
  const players = ((users.data ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((user) => ({
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar_url,
    points: profileById.get(user.id)?.points ?? 0,
    activisionId: profileById.get(user.id)?.activision_id ?? null,
  }));
  const team = (id: string) => {
    const row = teams.get(id);
    return row ? { id: row.id, name: row.name, tag: row.tag, color: row.color, logoUrl: row.logo_url, points: row.points } : null;
  };

  let viewer = null;
  let proofs: { id: number; userId: string; username: string; url: string; createdAt: string }[] | null = null;
  if (viewerId) {
    const side = await leaderSide(match, viewerId);
    const referee = await isReferee(viewerId);
    const state = seriesState(match.scores, match.best_of);
    const isPlayer = ids.includes(viewerId);
    viewer = {
      leaderOf: side,
      referee,
      isPlayer,
      canReport: Boolean(side) && match.status === 'in_progress' && state.phase !== 'done' && (state.phase !== 'decider' || match.maps.length === match.best_of),
      canConfirm: Boolean(side) && match.status === 'awaiting_confirmation' && match.reported_team !== side,
      canPickMap3: Boolean(side) && match.status === 'in_progress' && state.phase === 'decider' && match.maps.length === match.best_of - 1 && match.map3_picker === side,
      canResolve: referee && OPEN.includes(match.status),
      canProve: isPlayer && proofWindowOpen(match),
      canCorrect: referee && match.status === 'completed' && !match.tournament_id && withinWindow(match.completed_at, correctionWindowHours(await roleOf(viewerId))),
    };
    // Captures : visibles des joueurs du match et des arbitres seulement (liens signés d'une heure).
    if (isPlayer || referee) proofs = await proofsOf(match.id, players);
  }
  return {
    id: match.id,
    status: match.status,
    mode: match.mode,
    teamA: team(match.team_a),
    teamB: team(match.team_b),
    rosterA: match.roster_a,
    rosterB: match.roster_b,
    players,
    stakes: match.stakes,
    pointsBefore: { A: match.points_a, B: match.points_b },
    maps: match.maps,
    scores: match.scores,
    pendingScores: match.pending_scores,
    reportedTeam: match.reported_team,
    reportedAt: match.reported_at,
    map3Picker: match.map3_picker,
    winner: match.winner,
    pointsChanges: match.points_changes,
    cancelReason: match.cancel_reason,
    correctedAt: match.corrected_at,
    correctionReason: match.correction_reason,
    createdAt: match.created_at,
    completedAt: match.completed_at,
    mapPool:
      match.status === 'in_progress' && match.maps.length === match.best_of - 1 && match.scores.length === match.best_of - 1
        ? config.cod.maps.filter((map) => !match.maps.some((m) => m.map === map))
        : [],
    bestOf: match.best_of,
    tournament: match.tournament_id ? await tournamentLabel(match.tournament_id, match.round) : null,
    confirmMinutes: config.cod.confirmMinutes,
    proofs,
    viewer,
  };
}

// --- Captures de preuve -----------------------------------------------------------------------

const PROOF_BUCKET = 'team-match-proofs';
const MAX_PROOFS = 5;

/** Envoi possible pendant le match et jusqu'à 24 h après sa fin (comme le bucket, migration 0027). */
function proofWindowOpen(match: TeamMatch): boolean {
  if (OPEN.includes(match.status)) return true;
  return match.status === 'completed' && Boolean(match.completed_at) && Date.now() - new Date(match.completed_at!).getTime() < 24 * 3600_000;
}

async function proofsOf(matchId: string, players: { id: string; username: string }[]) {
  const rows = (unwrap(await supabase.from('team_match_proofs').select('id, user_id, storage_path, created_at').eq('match_id', matchId).order('created_at')) ?? []) as {
    id: number;
    user_id: string;
    storage_path: string;
    created_at: string;
  }[];
  if (rows.length === 0) return [];
  const { data, error } = await supabase.storage.from(PROOF_BUCKET).createSignedUrls(rows.map((row) => row.storage_path), 3600);
  if (error) {
    console.warn('[team-match] liens des captures impossibles', error.message);
    return [];
  }
  const urls = new Map((data ?? []).filter((item) => item.signedUrl).map((item) => [item.path, item.signedUrl]));
  const names = new Map(players.map((player) => [player.id, player.username]));
  return rows
    .filter((row) => urls.has(row.storage_path))
    .map((row) => ({ id: row.id, userId: row.user_id, username: names.get(row.user_id) ?? 'Joueur', url: urls.get(row.storage_path)!, createdAt: row.created_at }));
}

/** Enregistre une capture déjà envoyée par un titulaire dans le bucket (dossier <match>/<joueur>/). */
export async function addTeamProof(userId: string, matchId: string, body: unknown) {
  const match = await matchRow(matchId);
  if (![...match.roster_a, ...match.roster_b].includes(userId)) throw new HttpError(403, 'NOT_A_PLAYER', 'Tu ne joues pas ce match.');
  if (!proofWindowOpen(match)) throw new HttpError(409, 'MATCH_CLOSED', 'Les captures ne sont plus acceptées pour ce match (24 h après la fin).');
  const path = (body as { path?: unknown } | undefined)?.path;
  const prefix = `${matchId}/${userId}/`;
  if (typeof path !== 'string' || !path.startsWith(prefix) || !/^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/.test(path.slice(prefix.length))) {
    throw new HttpError(400, 'INVALID_PROOF', 'Fichier de preuve invalide.');
  }
  const { count, error } = await supabase.from('team_match_proofs').select('id', { count: 'exact', head: true }).eq('match_id', matchId).eq('user_id', userId);
  if (error) throw fromDbError(error);
  if ((count ?? 0) >= MAX_PROOFS) throw new HttpError(409, 'TOO_MANY_PROOFS', `Tu as déjà envoyé ${MAX_PROOFS} captures pour ce match.`);
  unwrap(await supabase.from('team_match_proofs').insert({ match_id: matchId, user_id: userId, storage_path: path }));
  return getTeamMatch(matchId, userId);
}

// --- Administration ------------------------------------------------------------------------------

/** Matchs d'équipe contestés, pour l'onglet admin « Contestations ». */
export async function listTeamDisputes() {
  const rows = (unwrap(await supabase.from('team_matches').select('*').eq('status', 'disputed').order('updated_at', { ascending: true })) ?? []) as TeamMatch[];
  const teams = await teamsById([...new Set(rows.flatMap((row) => [row.team_a, row.team_b]))]);
  const card = (id: string) => {
    const team = teams.get(id);
    return team ? { id: team.id, name: team.name, tag: team.tag, color: team.color, logoUrl: team.logo_url } : null;
  };
  return rows.map((row) => ({
    id: row.id,
    teamA: card(row.team_a),
    teamB: card(row.team_b),
    maps: row.maps,
    scores: row.scores,
    pendingScores: row.pending_scores,
    reportedTeam: row.reported_team,
    disputedAt: row.updated_at,
  }));
}

/** Un Leader déclare les scores de l'étape en cours (maps 1 et 2, ou map 3). */
export async function reportTeamScores(userId: string, matchId: string, body: unknown) {
  const match = await matchRow(matchId);
  const side = await leaderSide(match, userId);
  if (!side) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader d’une des deux équipes peut déclarer les scores.');
  if (match.status !== 'in_progress') throw new HttpError(409, 'MATCH_NOT_REPORTABLE', 'Des scores sont déjà déclarés ou le match est terminé.');
  const scores = (body as { scores?: unknown } | undefined)?.scores;
  const problem = declarationError(match.scores, scores, match.best_of);
  if (problem) throw new HttpError(400, 'INVALID_SCORES', problem);
  if (seriesState(match.scores, match.best_of).phase === 'decider' && match.maps.length < match.best_of) throw new HttpError(409, 'MAP3_NOT_PICKED', 'La map décisive n’est pas encore choisie.');

  const now = new Date().toISOString();
  const updated = unwrap(
    await supabase
      .from('team_matches')
      .update({ status: 'awaiting_confirmation', pending_scores: scores, reported_by: userId, reported_team: side, reported_at: now, updated_at: now })
      .eq('id', matchId)
      .eq('status', 'in_progress')
      .select('id')
      .maybeSingle(),
  );
  if (!updated) throw new HttpError(409, 'MATCH_NOT_REPORTABLE', 'Des scores viennent d’être déclarés : recharge la page.');
  const teams = await teamsById([match.team_a, match.team_b]);
  const reporter = teams.get(side === 'A' ? match.team_a : match.team_b)!;
  await pushToUsers(await leadersOf(side === 'A' ? match.team_b : match.team_a), {
    title: `Scores déclarés par [${reporter.tag}]`,
    body: `Confirme ou conteste sous ${config.cod.confirmMinutes} min, sinon ils seront validés.`,
    url: matchUrl(matchId),
    tag: `team-match-${matchId}`,
  });
  return getTeamMatch(matchId, userId);
}

/** Un Leader adverse confirme (étape suivante ou fin du match) ou conteste (arbitre). */
export async function confirmTeamScores(userId: string, matchId: string, body: unknown) {
  const match = await matchRow(matchId);
  const side = await leaderSide(match, userId);
  if (match.status !== 'awaiting_confirmation') throw new HttpError(409, 'MATCH_NOT_CONFIRMABLE', 'Ce match n’attend pas de confirmation.');
  if (!side || side === match.reported_team) throw new HttpError(403, 'SAME_TEAM_AS_REPORTER', 'La confirmation doit venir d’un Leader de l’équipe adverse.');

  if ((body as { accept?: unknown } | undefined)?.accept === true) {
    await applyConfirmed(match);
  } else {
    const updated = unwrap(
      await supabase
        .from('team_matches')
        .update({ status: 'disputed', updated_at: new Date().toISOString() })
        .eq('id', matchId)
        .eq('status', 'awaiting_confirmation')
        .select('id')
        .maybeSingle(),
    );
    if (!updated) throw new HttpError(409, 'MATCH_NOT_CONFIRMABLE', 'Ce match n’attend plus de confirmation.');
    const teams = await teamsById([match.team_a, match.team_b]);
    await notifyStaff(
      `⚔️ Match de Division contesté : **[${teams.get(match.team_a)?.tag}] vs [${teams.get(match.team_b)?.tag}]** — un arbitre doit trancher.\n${config.siteUrl}${matchUrl(matchId)}`,
    );
  }
  return getTeamMatch(matchId, userId);
}

/** Scores confirmés : fin du match, map suivante, ou map décisive (égalité avant la dernière map). */
async function applyConfirmed(match: TeamMatch): Promise<void> {
  const all = [...match.scores, ...(match.pending_scores ?? [])];
  const state = seriesState(all, match.best_of);
  if (state.winner) {
    unwrap(await supabase.rpc('team_match_finalize', { p_match: match.id, p_scores: all, p_winner: state.winner, p_resolved_by: null }));
    await afterClose(match);
    return;
  }
  if (state.phase === 'next') {
    unwrap(
      await supabase
        .from('team_matches')
        .update({ status: 'in_progress', scores: all, pending_scores: null, reported_by: null, reported_team: null, reported_at: null, updated_at: new Date().toISOString() })
        .eq('id', match.id)
        .eq('status', 'awaiting_confirmation'),
    );
    return;
  }
  const picker = deciderPicker(all);
  const maps = picker === 'random' ? [...match.maps, { map: pickMaps(config.cod.maps, 1, match.maps.map((m) => m.map))[0]!, pick: 'random' }] : match.maps;
  const updated = unwrap(
    await supabase
      .from('team_matches')
      .update({ status: 'in_progress', scores: all, pending_scores: null, reported_by: null, reported_team: null, reported_at: null, map3_picker: picker, maps, updated_at: new Date().toISOString() })
      .eq('id', match.id)
      .eq('status', 'awaiting_confirmation')
      .select('id')
      .maybeSingle(),
  );
  if (!updated) return;
  const teams = await teamsById([match.team_a, match.team_b]);
  if (picker === 'random') {
    await pushToUsers([...match.roster_a, ...match.roster_b], { title: 'Égalité : map décisive tirée au sort', body: `Égalité de manches : ce sera ${maps[maps.length - 1]!.map}.`, url: matchUrl(match.id), tag: `team-match-${match.id}` });
  } else {
    const pickerTeam = picker === 'A' ? match.team_a : match.team_b;
    await pushToUsers(await leadersOf(pickerTeam), { title: 'Égalité : à toi de choisir la map décisive', body: `[${teams.get(pickerTeam)?.tag}] a gagné le plus de manches.`, url: matchUrl(match.id), tag: `team-match-${match.id}` });
  }
}

/** Le Leader de l'équipe qui a gagné le plus de manches choisit la map 3. */
export async function pickTeamMap3(userId: string, matchId: string, body: unknown) {
  const match = await matchRow(matchId);
  const side = await leaderSide(match, userId);
  if (!side || match.map3_picker !== side) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Le choix de la map décisive revient à l’équipe qui a gagné le plus de manches.');
  if (match.status !== 'in_progress' || match.scores.length !== match.best_of - 1 || match.maps.length !== match.best_of - 1) {
    throw new HttpError(409, 'MAP3_CLOSED', 'La map décisive n’est pas à choisir maintenant.');
  }
  const map = (body as { map?: unknown } | undefined)?.map;
  if (typeof map !== 'string' || !config.cod.maps.includes(map) || match.maps.some((m) => m.map === map)) throw new HttpError(400, 'INVALID_MAP', 'Map invalide ou déjà jouée.');
  const updated = unwrap(
    await supabase
      .from('team_matches')
      .update({ maps: [...match.maps, { map, pick: side }], updated_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('status', 'in_progress')
      .eq('updated_at', match.updated_at)
      .select('id')
      .maybeSingle(),
  );
  if (!updated) throw new HttpError(409, 'MAP3_CLOSED', 'La map décisive vient d’être choisie : recharge la page.');
  await pushToUsers([...match.roster_a, ...match.roster_b], { title: `Map décisive : ${map}`, body: 'Bonne chance pour la manche décisive.', url: matchUrl(matchId), tag: `team-match-${matchId}` });
  return getTeamMatch(matchId, userId);
}

/** Arbitrage : scores définitifs de toute la série (vainqueur déduit), ou annulation (null). */
export async function resolveTeamMatch(staffId: string, matchId: string, body: unknown) {
  if (!(await isReferee(staffId))) throw new HttpError(403, 'FORBIDDEN', 'Réservé aux arbitres.');
  const match = await matchRow(matchId);
  if (!OPEN.includes(match.status)) throw new HttpError(409, 'MATCH_CLOSED', 'Ce match est déjà clôturé.');
  const scores = (body as { scores?: unknown } | undefined)?.scores;
  if (scores === null) {
    unwrap(
      await supabase
        .from('team_matches')
        .update({ status: 'cancelled', cancel_reason: 'staff', resolved_by: staffId, pending_scores: null, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', matchId),
    );
  } else {
    if (!isCompleteSeries(scores, match.best_of)) throw new HttpError(400, 'INVALID_SCORES', 'Scores invalides : la série doit se terminer sur la dernière map saisie.');
    unwrap(await supabase.rpc('team_match_finalize', { p_match: matchId, p_scores: scores, p_winner: seriesState(scores, match.best_of).winner, p_resolved_by: staffId }));
  }
  await afterClose(match);
  return getTeamMatch(matchId, staffId);
}

/** Match de tournoi terminé ou annulé : le tableau avance (chargé à la demande, évite une dépendance circulaire). */
async function afterClose(match: TeamMatch): Promise<void> {
  if (!match.tournament_id) return;
  const { advanceTournament } = await import('./tournaments.js');
  await advanceTournament(match.tournament_id).catch((caught: Error) => console.error('[tournoi] avancement impossible', caught.message));
}

async function tournamentLabel(tournamentId: string, round: number | null) {
  const row = unwrap(await supabase.from('tournaments').select('id, name, size').eq('id', tournamentId).maybeSingle()) as { id: string; name: string; size: number } | null;
  if (!row) return null;
  const { roundName, roundsFor } = await import('./tournamentPolicy.js');
  return { id: row.id, name: row.name, round: round ? roundName(round, roundsFor(row.size)) : null };
}

/**
 * Correction d'un match terminé (mauvaise déclaration…) : nouveaux scores de toute la série (le
 * vainqueur peut changer) ou annulation (scores null). Arbitre et staff : 48 h ; admin : sans limite.
 * Pas pour les matchs de tournoi (l'admin désigne le vainqueur depuis l'onglet Tournoi).
 */
export async function correctTeamMatch(staffId: string, matchId: string, body: unknown) {
  if (!(await isReferee(staffId))) throw new HttpError(403, 'FORBIDDEN', 'Réservé à l’équipe SixSence.');
  const match = await matchRow(matchId);
  const input = (body ?? {}) as { scores?: unknown; reason?: unknown };
  const reason = typeof input.reason === 'string' ? input.reason : '';
  let winner: Side | null = null;
  if (input.scores !== null) {
    if (!isCompleteSeries(input.scores, match.best_of)) throw new HttpError(400, 'INVALID_SCORES', 'Scores invalides : la série doit se terminer sur la dernière map saisie.');
    winner = seriesState(input.scores, match.best_of).winner;
  }
  unwrap(
    await supabase.rpc('team_match_correct', {
      p_match: matchId,
      p_scores: input.scores === null ? null : input.scores,
      p_winner: winner,
      p_staff: staffId,
      p_reason: reason,
      p_max_hours: correctionWindowHours(await roleOf(staffId)),
    }),
  );
  await pushToUsers([...match.roster_a, ...match.roster_b], {
    title: 'Résultat du match de Division corrigé',
    body: input.scores === null ? 'Le match a été annulé par l’équipe SixSence : points rendus.' : 'L’équipe SixSence a corrigé les scores : points recalculés.',
    url: matchUrl(matchId),
    tag: `team-match-${matchId}`,
  });
  return getTeamMatch(matchId, staffId);
}

// --- Historique d'une équipe ----------------------------------------------------------------

export async function teamMatchHistory(teamId: string) {
  const rows = (unwrap(
    await supabase
      .from('team_matches')
      .select('id, team_a, team_b, status, scores, winner, points_changes, created_at, completed_at')
      .or(`team_a.eq.${teamId},team_b.eq.${teamId}`)
      .in('status', ['completed', ...OPEN])
      .order('created_at', { ascending: false })
      .limit(10),
  ) ?? []) as Pick<TeamMatch, 'id' | 'team_a' | 'team_b' | 'status' | 'scores' | 'winner' | 'points_changes' | 'created_at' | 'completed_at'>[];
  const teams = await teamsById([...new Set(rows.flatMap((row) => [row.team_a, row.team_b]))]);
  return rows.map((row) => {
    const side: Side = row.team_a === teamId ? 'A' : 'B';
    const opponent = teams.get(side === 'A' ? row.team_b : row.team_a);
    const state = seriesState(row.scores, 5);
    return {
      id: row.id,
      status: row.status,
      opponent: opponent ? { id: opponent.id, name: opponent.name, tag: opponent.tag, color: opponent.color, logoUrl: opponent.logo_url } : null,
      mapsFor: side === 'A' ? state.mapsA : state.mapsB,
      mapsAgainst: side === 'A' ? state.mapsB : state.mapsA,
      won: row.winner ? row.winner === side : null,
      points: row.points_changes?.[side] ?? null,
      date: row.completed_at ?? row.created_at,
    };
  });
}

// --- Ménage et Discord ----------------------------------------------------------------------------

/** Scores non confirmés validés d'office ; matchs sans résultat annulés ; salons et résultats Discord. */
export async function sweepTeamMatches(): Promise<void> {
  try {
    const confirmBefore = new Date(Date.now() - config.cod.confirmMinutes * 60_000).toISOString();
    const cancelBefore = new Date(Date.now() - config.cod.cancelMinutes * 60_000).toISOString();
    const late = (unwrap(await supabase.from('team_matches').select('*').eq('status', 'awaiting_confirmation').lt('reported_at', confirmBefore)) ?? []) as TeamMatch[];
    for (const match of late) await applyConfirmed(match);
    unwrap(
      await supabase
        .from('team_matches')
        .update({ status: 'cancelled', cancel_reason: 'abandoned', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('status', 'in_progress')
        .is('tournament_id', null)
        .lt('updated_at', cancelBefore),
    );
    await sweepTeamDiscord();
  } catch (caught) {
    console.error('[team-match] ménage impossible', (caught as Error).message);
  }
}

async function sweepTeamDiscord(): Promise<void> {
  const rows = (unwrap(await supabase.from('team_matches').select('*').in('status', ['completed', 'cancelled']).eq('discord_done', false).limit(20)) ?? []) as TeamMatch[];
  for (const match of rows) {
    if (discordEnabled && config.teams.discord) {
      for (const id of Object.values(match.discord_channels ?? {})) await discord(`/channels/${id}`, { method: 'DELETE' }).catch(() => {});
      const { resultsChannelId } = config.discord;
      if (match.status === 'completed' && match.winner && resultsChannelId) {
        const teams = await teamsById([match.team_a, match.team_b]);
        const a = teams.get(match.team_a);
        const b = teams.get(match.team_b);
        const winner = match.winner === 'A' ? a : b;
        const gain = match.points_changes?.[match.winner] ?? 0;
        await discord(`/channels/${resultsChannelId}/messages`, {
          method: 'POST',
          body: {
            content:
              `⚔️ **Division** · [${a?.tag}] ${a?.name} vs [${b?.tag}] ${b?.name} — victoire de **${winner?.name}** (+${gain} pts)${match.corrected_at ? ' (résultat corrigé)' : ''}\n` +
              `${match.scores.map(([x, y], i) => `${match.maps[i]?.map ?? `Map ${i + 1}`} ${x}-${y}`).join(' · ')}\n${config.siteUrl}${matchUrl(match.id)}`,
            flags: SUPPRESS_EMBEDS,
          },
        }).catch((caught) => console.warn('[team-match] résultat Discord impossible', (caught as Error).message));
      }
    }
    await supabase.from('team_matches').update({ discord_done: true }).eq('id', match.id);
    if (match.status === 'completed' && !match.corrected_at) {
      await pushToUsers([...match.roster_a, ...match.roster_b], {
        title: 'Match de Division terminé',
        body: `Victoire de l’équipe ${match.winner === 'A' ? '1' : '2'} · ${match.scores.map(([x, y]) => `${x}-${y}`).join(' · ')}`,
        url: matchUrl(match.id),
        tag: `team-match-${match.id}`,
      });
    }
  }
}
