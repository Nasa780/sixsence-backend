import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { SUPPRESS_EMBEDS, discord, discordEnabled, discordIds, notifyStaff } from './discord.js';
import { pushToUsers } from './push.js';
import { pickMaps } from './teamMatchPolicy.js';
import { membershipOf } from './teams.js';
import {
  CHECKIN_MINUTES,
  CUP_BONUS,
  CUP_MIN_TEAMS,
  CUP_SIZES,
  QUALIFY_MATCHES,
  TOURNAMENT_SIZES,
  advanceBracket,
  bestOfFor,
  bracketSizeFor,
  emptyRounds,
  firstRound,
  isThirdPlace,
  podium,
  qualifiedTeams,
  readyEntries,
  roundName,
  roundsFor,
  shuffle,
  type BracketEntry,
} from './tournamentPolicy.js';

/**
 * Tournoi de fin de saison (Division, étape 3) : création par un admin (qualifiés et
 * effectifs figés), check-in des Leaders 30 min avant, déroulé automatique en une soirée (matchs
 * créés dès que deux équipes se font face), trophées et rôle Discord du vainqueur.
 * Règles pures dans tournamentPolicy.ts ; tables et fonctions SQL dans la migration 0028.
 *
 * Coupe Horus (kind 'horus', migration 0038) : même moteur, mais inscription libre des équipes (un Leader
 * inscrit ou désinscrit son équipe jusqu'au début), check-in 30 min avant, tableau tiré au sort parmi les
 * équipes présentes (4 au minimum, sinon coupe annulée), matchs en BO1 ou BO3, finale en BO3 ou BO5,
 * petite finale. Récompenses : trophées or / argent / bronze, points de Division (CUP_BONUS) et rôle
 * Discord « Vainqueur — Coupe Horus » gardé jusqu'à la coupe suivante. Rendez-vous récurrents
 * (cup_schedules) créés automatiquement quand l'interrupteur app_state 'cups_auto' vaut 'on'.
 */

type Kind = 'saison' | 'horus';

interface TournamentRow {
  id: string;
  season_id: number | null;
  kind: Kind;
  best_of: number;
  final_best_of: number;
  third_place: boolean;
  third_team: string | null;
  schedule_id: string | null;
  name: string;
  size: number;
  starts_at: string;
  status: 'scheduled' | 'running' | 'completed' | 'cancelled';
  winner_team: string | null;
  finalist_team: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface EntryRow {
  id: number;
  tournament_id: string;
  round: number;
  slot: number;
  team_a: string | null;
  team_b: string | null;
  winner: string | null;
  status: BracketEntry['status'];
  match_id: string | null;
}

interface ParticipantRow {
  tournament_id: string;
  team_id: string;
  seed: number;
  frozen_roster: string[];
  match_roster: string[] | null;
  checked_in_at: string | null;
  forfeit: boolean;
}

const PAGE = '/cod/tournoi';
const HORUS_ROLE = 'Vainqueur — Coupe Horus';
const formatOf = (tournament: TournamentRow) => ({ bestOf: tournament.best_of, finalBestOf: tournament.final_best_of });
const toEntry = (row: EntryRow): BracketEntry => ({ round: row.round, slot: row.slot, teamA: row.team_a, teamB: row.team_b, winner: row.winner, status: row.status });

async function tournamentRow(id: string): Promise<TournamentRow> {
  const row = unwrap(await supabase.from('tournaments').select('*').eq('id', id).maybeSingle()) as TournamentRow | null;
  if (!row) throw new HttpError(404, 'TOURNAMENT_NOT_FOUND', 'Tournoi introuvable.');
  return row;
}

async function entriesOf(id: string): Promise<EntryRow[]> {
  return (unwrap(await supabase.from('tournament_bracket').select('*').eq('tournament_id', id).order('round').order('slot')) ?? []) as EntryRow[];
}

async function participantsOf(id: string): Promise<ParticipantRow[]> {
  return (unwrap(await supabase.from('tournament_teams').select('*').eq('tournament_id', id).order('seed')) ?? []) as ParticipantRow[];
}

/** Équipes actives avec leurs matchs joués, pour la qualification. */
async function rankedTeams() {
  const rows = (unwrap(await supabase.from('teams').select('id, name, tag, color, logo_url, points, wins, losses, created_at').is('disbanded_at', null)) ?? []) as {
    id: string;
    name: string;
    tag: string;
    color: string;
    logo_url: string | null;
    points: number;
    wins: number;
    losses: number;
    created_at: string;
  }[];
  return rows.map((row) => ({ ...row, played: row.wins + row.losses, createdAt: row.created_at }));
}

// --- Administration --------------------------------------------------------------------------

function parseCreate(body: unknown): { name: string; startsAt: Date; size: number } {
  const input = (body ?? {}) as { name?: unknown; startsAt?: unknown; size?: unknown };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 3 || name.length > 60) throw new HttpError(400, 'INVALID_TOURNAMENT', 'Le nom du tournoi fait entre 3 et 60 caractères.');
  const size = Number(input.size);
  if (!(TOURNAMENT_SIZES as readonly number[]).includes(size)) throw new HttpError(400, 'INVALID_TOURNAMENT', 'Nombre de places : 8, 16 ou 32.');
  const startsAt = new Date(typeof input.startsAt === 'string' ? input.startsAt : '');
  if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'INVALID_TOURNAMENT', 'Date de début invalide.');
  if (startsAt.getTime() < Date.now() + CHECKIN_MINUTES * 60_000) throw new HttpError(400, 'INVALID_TOURNAMENT', `Le tournoi doit commencer dans plus de ${CHECKIN_MINUTES} min (check-in).`);
  return { name, startsAt, size };
}

/** Aperçu des qualifiés (admin) avant de créer le tournoi. */
export async function previewQualified(size: unknown) {
  const places = (TOURNAMENT_SIZES as readonly number[]).includes(Number(size)) ? Number(size) : 16;
  const teams = await rankedTeams();
  return {
    size: places,
    minMatches: QUALIFY_MATCHES,
    qualified: qualifiedTeams(teams, places).map((team, index) => ({ seed: index + 1, id: team.id, name: team.name, tag: team.tag, color: team.color, logoUrl: team.logo_url, points: team.points, played: team.played })),
  };
}

/** Crée le tournoi : qualifiés figés (têtes de série, effectifs), tableau du 1er tour. */
export async function createTournament(adminId: string, body: unknown) {
  if (!config.teams.enabled) throw new HttpError(403, 'TEAM_MODE_PAUSED', 'La Division est en pause.');
  const { name, startsAt, size } = parseCreate(body);
  const { count, error } = await supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('kind', 'saison').in('status', ['scheduled', 'running']);
  if (error) throw fromDbError(error);
  if ((count ?? 0) > 0) throw new HttpError(409, 'TOURNAMENT_EXISTS', 'Un tournoi est déjà prévu ou en cours.');

  const qualified = qualifiedTeams(await rankedTeams(), size);
  if (qualified.length < 2) throw new HttpError(409, 'NOT_ENOUGH_TEAMS', `Il faut au moins 2 équipes avec ${QUALIFY_MATCHES} matchs pour lancer un tournoi.`);
  const members = (unwrap(await supabase.from('team_members').select('team_id, user_id').in('team_id', qualified.map((team) => team.id))) ?? []) as { team_id: string; user_id: string }[];
  const season = unwrap(await supabase.from('seasons').select('id').eq('is_active', true).maybeSingle()) as { id: number } | null;

  const tournament = unwrap(
    await supabase.from('tournaments').insert({ name, size, starts_at: startsAt.toISOString(), season_id: season?.id ?? null, created_by: adminId }).select('*').single(),
  ) as TournamentRow;
  unwrap(
    await supabase.from('tournament_teams').insert(
      qualified.map((team, index) => ({
        tournament_id: tournament.id,
        team_id: team.id,
        seed: index + 1,
        frozen_roster: members.filter((member) => member.team_id === team.id).map((member) => member.user_id),
      })),
    ),
  );
  const bracket = [...firstRound(qualified.map((team) => team.id), size), ...emptyRounds(size)];
  unwrap(
    await supabase
      .from('tournament_bracket')
      .insert(bracket.map((entry) => ({ tournament_id: tournament.id, round: entry.round, slot: entry.slot, team_a: entry.teamA, team_b: entry.teamB, status: entry.status }))),
  );

  const date = startsAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  await pushToUsers(members.map((member) => member.user_id), {
    title: `🏆 Ton équipe est qualifiée : ${name}`,
    body: `Début ${date}. Check-in d’un Leader ${CHECKIN_MINUTES} min avant.`,
    url: PAGE,
    tag: `tournoi-${tournament.id}`,
  });
  await announce(`🏆 **${name}** — ${qualified.length} équipes qualifiées, début ${date} (check-in ${CHECKIN_MINUTES} min avant).\n${config.siteUrl}${PAGE}`);
  return getTournament(tournament.id, null);
}

export async function cancelTournament(id: string) {
  const tournament = await tournamentRow(id);
  if (tournament.status === 'completed' || tournament.status === 'cancelled') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'Ce tournoi est déjà terminé.');
  unwrap(await supabase.from('tournaments').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', id));
  unwrap(
    await supabase
      .from('team_matches')
      .update({ status: 'cancelled', cancel_reason: 'staff', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('tournament_id', id)
      .in('status', ['in_progress', 'awaiting_confirmation', 'disputed']),
  );
  return { ok: true };
}

/** Désigne le vainqueur d'une rencontre (match annulé, bloqué, ou décision de l'équipe SixSence). */
export async function forceEntryWinner(id: string, entryId: unknown, body: unknown) {
  const tournament = await tournamentRow(id);
  if (tournament.status !== 'running') throw new HttpError(409, 'TOURNAMENT_NOT_RUNNING', 'Le tournoi n’est pas en cours.');
  const side = (body as { side?: unknown } | undefined)?.side;
  if (side !== 'A' && side !== 'B') throw new HttpError(400, 'INVALID_WINNER', 'Vainqueur invalide.');
  const entry = unwrap(await supabase.from('tournament_bracket').select('*').eq('id', Number(entryId)).eq('tournament_id', id).maybeSingle()) as EntryRow | null;
  if (!entry || !entry.team_a || !entry.team_b || entry.status === 'done') throw new HttpError(409, 'ENTRY_CLOSED', 'Cette rencontre ne peut pas être modifiée.');
  if (entry.match_id) {
    await supabase
      .from('team_matches')
      .update({ status: 'cancelled', cancel_reason: 'staff', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', entry.match_id)
      .in('status', ['in_progress', 'awaiting_confirmation', 'disputed']);
  }
  unwrap(await supabase.from('tournament_bracket').update({ winner: side === 'A' ? entry.team_a : entry.team_b, status: 'done' }).eq('id', entry.id));
  await advanceTournament(id);
  return getTournament(id, null);
}

export async function listTournaments() {
  const rows = (unwrap(await supabase.from('tournaments').select('*').order('created_at', { ascending: false }).limit(10)) ?? []) as TournamentRow[];
  return rows.map((row) => ({ id: row.id, kind: row.kind, name: row.name, size: row.size, startsAt: row.starts_at, status: row.status }));
}

// --- Lecture --------------------------------------------------------------------------------

/** Tournoi à afficher (de saison ou Coupe Horus) : prévu ou en cours, sinon le dernier terminé. */
export async function currentTournament(viewerId: string | null, kind: Kind = 'saison') {
  const active = unwrap(
    await supabase.from('tournaments').select('id').eq('kind', kind).in('status', ['scheduled', 'running']).order('starts_at').limit(1).maybeSingle(),
  ) as { id: string } | null;
  const last =
    active ??
    (unwrap(await supabase.from('tournaments').select('id').eq('kind', kind).eq('status', 'completed').order('completed_at', { ascending: false }).limit(1).maybeSingle()) as {
      id: string;
    } | null);
  return last ? getTournament(last.id, viewerId) : null;
}

export async function getTournament(id: string, viewerId: string | null) {
  const tournament = await tournamentRow(id);
  const [participants, rows] = await Promise.all([participantsOf(id), entriesOf(id)]);
  const rounds = roundsFor(tournament.size);
  const teamIds = participants.map((p) => p.team_id);
  const teams = teamIds.length
    ? ((unwrap(await supabase.from('teams').select('id, name, tag, color, logo_url, points').in('id', teamIds)) ?? []) as {
        id: string;
        name: string;
        tag: string;
        color: string;
        logo_url: string | null;
        points: number;
      }[])
    : [];
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const matchIds = rows.map((row) => row.match_id).filter(Boolean) as string[];
  const matches = matchIds.length
    ? ((unwrap(await supabase.from('team_matches').select('id, status, scores, winner, best_of').in('id', matchIds)) ?? []) as { id: string; status: string; scores: [number, number][]; winner: string | null; best_of: number }[])
    : [];
  const matchById = new Map(matches.map((match) => [match.id, match]));
  // Avant le début : le tableau affiche déjà les têtes de série et les places vides.
  const display = tournament.status === 'scheduled' ? advanceBracket(rows.map(toEntry), rounds) : rows.map(toEntry);
  const card = (teamId: string | null) => {
    const team = teamId ? teamById.get(teamId) : null;
    const participant = participants.find((p) => p.team_id === teamId);
    return team ? { id: team.id, name: team.name, tag: team.tag, color: team.color, logoUrl: team.logo_url, seed: participant?.seed ?? null } : null;
  };

  let viewer = null;
  if (viewerId) {
    const member = await membershipOf(viewerId);
    const participant = member ? participants.find((p) => p.team_id === member.team_id) : undefined;
    const isLeader = Boolean(member && (member.role === 'leader' || member.isOwner));
    const open = tournament.status === 'scheduled' && Date.now() < new Date(tournament.starts_at).getTime();
    if (member && participant) {
      // Coupe Horus : l'effectif est celui du moment (pas figé à l'inscription).
      const roster = tournament.kind === 'horus' ? await teamMemberIds(member.team_id) : participant.frozen_roster;
      viewer = {
        teamId: member.team_id,
        isLeader,
        registered: true,
        checkedIn: Boolean(participant.checked_in_at),
        matchRoster: participant.match_roster,
        frozenRoster: await namesOf(roster),
        rosterSize: config.teams.rosterSize,
        canCheckIn: isLeader && tournament.status === 'scheduled' && checkInOpen(tournament),
        canRegister: false,
        canUnregister: tournament.kind === 'horus' && isLeader && open,
      };
    } else if (member && tournament.kind === 'horus') {
      viewer = {
        teamId: member.team_id,
        isLeader,
        registered: false,
        checkedIn: false,
        matchRoster: null,
        frozenRoster: [],
        rosterSize: config.teams.rosterSize,
        canCheckIn: false,
        canRegister: isLeader && open && participants.length < tournament.size,
        canUnregister: false,
      };
    }
  }

  const present = (entry: BracketEntry) => {
    const row = rows.find((r) => r.round === entry.round && r.slot === entry.slot);
    const match = row?.match_id ? matchById.get(row.match_id) : undefined;
    const mapsA = match ? match.scores.filter(([a, b]) => a > b).length : null;
    return {
      id: row?.id ?? null,
      slot: entry.slot,
      teamA: card(entry.teamA),
      teamB: card(entry.teamB),
      winner: entry.winner,
      status: entry.status,
      matchId: row?.match_id ?? null,
      score: match ? [mapsA, match.scores.length - mapsA!] : null,
    };
  };
  const thirdEntry = display.find((entry) => isThirdPlace(entry, rounds));

  return {
    id: tournament.id,
    kind: tournament.kind,
    name: tournament.name,
    size: tournament.size,
    bestOf: tournament.best_of,
    finalBestOf: tournament.final_best_of,
    registered: participants.length,
    third: card(tournament.third_team),
    thirdPlace: thirdEntry ? { name: 'Petite finale', bestOf: tournament.best_of, entry: present(thirdEntry) } : null,
    status: tournament.status,
    startsAt: tournament.starts_at,
    checkInOpensAt: new Date(new Date(tournament.starts_at).getTime() - CHECKIN_MINUTES * 60_000).toISOString(),
    completedAt: tournament.completed_at,
    winner: card(tournament.winner_team),
    finalist: card(tournament.finalist_team),
    teams: participants.map((p) => ({ ...card(p.team_id)!, checkedIn: Boolean(p.checked_in_at), forfeit: p.forfeit })),
    rounds: Array.from({ length: rounds }, (_, index) => {
      const round = index + 1;
      return {
        round,
        name: roundName(round, rounds),
        bestOf: bestOfFor(round, rounds, formatOf(tournament)),
        entries: display.filter((entry) => entry.round === round && !isThirdPlace(entry, rounds)).map(present),
      };
    }),
    viewer,
  };
}

async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = (unwrap(await supabase.from('team_members').select('user_id').eq('team_id', teamId)) ?? []) as { user_id: string }[];
  return rows.map((row) => row.user_id);
}

async function namesOf(ids: string[]) {
  if (ids.length === 0) return [];
  const rows = (unwrap(await supabase.from('users').select('id, username, avatar_url').in('id', ids)) ?? []) as { id: string; username: string; avatar_url: string | null }[];
  return rows.map((row) => ({ id: row.id, username: row.username, avatarUrl: row.avatar_url }));
}

const checkInOpen = (tournament: TournamentRow) => {
  const start = new Date(tournament.starts_at).getTime();
  return Date.now() >= start - CHECKIN_MINUTES * 60_000 && Date.now() < start;
};

// --- Check-in -----------------------------------------------------------------------------

/** Check-in d'un Leader : joueurs du match choisis parmi l'effectif figé (modifiables jusqu'au début). */
export async function checkIn(userId: string, id: string, body: unknown) {
  const tournament = await tournamentRow(id);
  if (tournament.status !== 'scheduled') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'Le check-in est fermé.');
  if (!checkInOpen(tournament)) throw new HttpError(409, 'CHECKIN_CLOSED', `Le check-in ouvre ${CHECKIN_MINUTES} min avant le début du tournoi.`);
  const member = await membershipOf(userId);
  if (!member || !(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut faire le check-in.');
  const participant = (await participantsOf(id)).find((p) => p.team_id === member.team_id);
  if (!participant) {
    throw new HttpError(403, 'NOT_QUALIFIED', tournament.kind === 'horus' ? 'Ton équipe n’est pas inscrite à cette coupe.' : 'Ton équipe n’est pas qualifiée pour ce tournoi.');
  }
  // Coupe Horus : l'effectif est figé au check-in (celui du moment).
  if (tournament.kind === 'horus') {
    participant.frozen_roster = await teamMemberIds(member.team_id);
    unwrap(await supabase.from('tournament_teams').update({ frozen_roster: participant.frozen_roster }).eq('tournament_id', id).eq('team_id', member.team_id));
  }
  const size = config.teams.rosterSize;
  const roster = (body as { roster?: unknown } | undefined)?.roster;
  if (!Array.isArray(roster) || roster.length !== size || new Set(roster).size !== size || !roster.every((rid) => participant.frozen_roster.includes(rid))) {
    throw new HttpError(400, 'INVALID_ROSTER', `Choisis ${size} joueur${size > 1 ? 's' : ''} parmi l’effectif inscrit au tournoi.`);
  }
  unwrap(
    await supabase
      .from('tournament_teams')
      .update({ match_roster: roster, checked_in_at: participant.checked_in_at ?? new Date().toISOString() })
      .eq('tournament_id', id)
      .eq('team_id', member.team_id),
  );
  return getTournament(id, userId);
}

/** Coupe Horus : un Leader inscrit son équipe (places limitées, jusqu'au début). */
export async function registerTeam(userId: string, id: string) {
  const tournament = await tournamentRow(id);
  if (tournament.kind !== 'horus') throw new HttpError(409, 'NOT_A_CUP', 'Ce tournoi se joue sur qualification.');
  if (tournament.status !== 'scheduled' || Date.now() >= new Date(tournament.starts_at).getTime()) throw new HttpError(409, 'REGISTRATION_CLOSED', 'Les inscriptions sont fermées.');
  const member = await membershipOf(userId);
  if (!member || !(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut inscrire l’équipe.');
  const participants = await participantsOf(id);
  if (participants.some((p) => p.team_id === member.team_id)) return getTournament(id, userId);
  if (participants.length >= tournament.size) throw new HttpError(409, 'CUP_FULL', 'La coupe est complète.');
  const roster = await teamMemberIds(member.team_id);
  if (roster.length < config.teams.rosterSize) {
    throw new HttpError(409, 'TEAM_TOO_SMALL', `Il faut au moins ${config.teams.rosterSize} joueur${config.teams.rosterSize > 1 ? 's' : ''} dans l’équipe pour s’inscrire.`);
  }
  unwrap(await supabase.from('tournament_teams').insert({ tournament_id: id, team_id: member.team_id, seed: participants.length + 1, frozen_roster: roster }));
  const left = tournament.size - participants.length - 1;
  if (left === 1 || left === 0) await announce(`🏆 **${tournament.name}** : ${left === 0 ? 'complète !' : 'plus qu’une place !'}\n${config.siteUrl}${PAGE}`, tournament.kind);
  return getTournament(id, userId);
}

/** Coupe Horus : un Leader désinscrit son équipe (jusqu'au début). */
export async function unregisterTeam(userId: string, id: string) {
  const tournament = await tournamentRow(id);
  if (tournament.kind !== 'horus') throw new HttpError(409, 'NOT_A_CUP', 'Ce tournoi se joue sur qualification.');
  if (tournament.status !== 'scheduled' || Date.now() >= new Date(tournament.starts_at).getTime()) throw new HttpError(409, 'REGISTRATION_CLOSED', 'La coupe a commencé.');
  const member = await membershipOf(userId);
  if (!member || !(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut désinscrire l’équipe.');
  unwrap(await supabase.from('tournament_teams').delete().eq('tournament_id', id).eq('team_id', member.team_id));
  return getTournament(id, userId);
}

/** Équipe encore en lice dans un tournoi en cours ou prévu (elle ne peut pas lancer de match ordinaire). */
export async function teamBusyInTournament(teamId: string): Promise<boolean> {
  const rows = (unwrap(await supabase.from('tournament_teams').select('tournament_id, forfeit').eq('team_id', teamId)) ?? []) as { tournament_id: string; forfeit: boolean }[];
  for (const row of rows) {
    if (row.forfeit) continue;
    const tournament = unwrap(await supabase.from('tournaments').select('status, starts_at').eq('id', row.tournament_id).single()) as { status: string; starts_at: string };
    // Dès l'ouverture du check-in, l'équipe se réserve pour le tournoi.
    if (tournament.status === 'scheduled') {
      if (Date.now() >= new Date(tournament.starts_at).getTime() - CHECKIN_MINUTES * 60_000) return true;
      continue;
    }
    if (tournament.status !== 'running') continue;
    const entries = await entriesOf(row.tournament_id);
    const eliminated = entries.some((e) => e.status === 'done' && (e.team_a === teamId || e.team_b === teamId) && e.winner !== teamId);
    if (!eliminated) return true;
  }
  return false;
}

// --- Déroulé ---------------------------------------------------------------------------------

/** Tâche toutes les minutes : départ des tournois à l'heure, puis avancement des tableaux. */
export async function sweepTournaments(): Promise<void> {
  try {
    const due = (unwrap(await supabase.from('tournaments').select('*').eq('status', 'scheduled').lte('starts_at', new Date().toISOString())) ?? []) as TournamentRow[];
    for (const tournament of due) await startTournament(tournament);
    const running = (unwrap(await supabase.from('tournaments').select('id').eq('status', 'running')) ?? []) as { id: string }[];
    for (const row of running) await advanceTournament(row.id);
    await ensureScheduledCups();
  } catch (caught) {
    console.error('[tournoi] tâche impossible', (caught as Error).message);
  }
}

/** Début : équipes sans check-in déclarées forfait (retirées du 1er tour), puis 1ers matchs. */
async function startTournament(tournament: TournamentRow): Promise<void> {
  if (tournament.kind === 'horus') return startCup(tournament);
  const claimed = unwrap(
    await supabase.from('tournaments').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', tournament.id).eq('status', 'scheduled').select('id').maybeSingle(),
  );
  if (!claimed) return;
  const participants = await participantsOf(tournament.id);
  const absent = participants.filter((p) => !p.checked_in_at).map((p) => p.team_id);
  if (absent.length > 0) {
    unwrap(await supabase.from('tournament_teams').update({ forfeit: true }).eq('tournament_id', tournament.id).in('team_id', absent));
    for (const entry of (await entriesOf(tournament.id)).filter((e) => e.round === 1)) {
      const patch: Record<string, null> = {};
      if (entry.team_a && absent.includes(entry.team_a)) patch.team_a = null;
      if (entry.team_b && absent.includes(entry.team_b)) patch.team_b = null;
      if (Object.keys(patch).length) unwrap(await supabase.from('tournament_bracket').update(patch).eq('id', entry.id));
    }
  }
  await announce(`🏆 **${tournament.name}** commence !${absent.length ? ` ${absent.length} équipe(s) forfait (pas de check-in).` : ''}\n${config.siteUrl}${PAGE}`);
  await advanceTournament(tournament.id);
}

/**
 * Début d'une Coupe Horus : équipes sans check-in retirées ; moins de 4 présentes = coupe annulée ;
 * sinon tableau tiré au sort, à la taille juste (4, 8 ou 16), avec petite finale.
 */
async function startCup(tournament: TournamentRow): Promise<void> {
  const participants = await participantsOf(tournament.id);
  const present = participants.filter((p) => p.checked_in_at);
  const absent = participants.filter((p) => !p.checked_in_at).map((p) => p.team_id);
  if (present.length < CUP_MIN_TEAMS) {
    const claimed = unwrap(
      await supabase.from('tournaments').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', tournament.id).eq('status', 'scheduled').select('id').maybeSingle(),
    );
    if (!claimed) return;
    await pushToUsers(participants.flatMap((p) => p.frozen_roster), {
      title: `🏆 ${tournament.name} annulée`,
      body: `Pas assez d’équipes présentes au check-in (${present.length} sur ${CUP_MIN_TEAMS} minimum).`,
      url: PAGE,
      tag: `tournoi-${tournament.id}`,
    });
    await announce(`🏆 **${tournament.name}** annulée : pas assez d’équipes présentes au check-in (${present.length}/${CUP_MIN_TEAMS}).`, tournament.kind);
    return;
  }
  const size = bracketSizeFor(present.length, tournament.size);
  const claimed = unwrap(
    await supabase.from('tournaments').update({ status: 'running', started_at: new Date().toISOString(), size }).eq('id', tournament.id).eq('status', 'scheduled').select('id').maybeSingle(),
  );
  if (!claimed) return;
  if (absent.length) unwrap(await supabase.from('tournament_teams').update({ forfeit: true }).eq('tournament_id', tournament.id).in('team_id', absent));
  const drawn = shuffle(present.map((p) => p.team_id));
  for (const [index, teamId] of drawn.entries()) {
    unwrap(await supabase.from('tournament_teams').update({ seed: index + 1 }).eq('tournament_id', tournament.id).eq('team_id', teamId));
  }
  const bracket = [...firstRound(drawn, size), ...emptyRounds(size, tournament.third_place)];
  unwrap(
    await supabase
      .from('tournament_bracket')
      .insert(bracket.map((entry) => ({ tournament_id: tournament.id, round: entry.round, slot: entry.slot, team_a: entry.teamA, team_b: entry.teamB, status: entry.status }))),
  );
  await announce(`🏆 **${tournament.name}** commence : ${present.length} équipes, tableau tiré au sort !\n${config.siteUrl}${PAGE}`, tournament.kind);
  await advanceTournament(tournament.id);
}

/** Avance le tableau : résultats des matchs reportés, rencontres suivantes créées, fin du tournoi. */
export async function advanceTournament(id: string): Promise<void> {
  const tournament = await tournamentRow(id);
  if (tournament.status !== 'running') return;
  const rounds = roundsFor(tournament.size);
  const rows = await entriesOf(id);

  // Résultats des matchs joués.
  const playing = rows.filter((row) => row.status === 'playing' && row.match_id);
  if (playing.length) {
    const matches = (unwrap(await supabase.from('team_matches').select('id, status, winner, team_a, team_b').in('id', playing.map((row) => row.match_id!))) ?? []) as {
      id: string;
      status: string;
      winner: 'A' | 'B' | null;
      team_a: string;
      team_b: string;
    }[];
    for (const row of playing) {
      const match = matches.find((m) => m.id === row.match_id);
      if (match?.status === 'completed' && match.winner) {
        row.winner = match.winner === 'A' ? match.team_a : match.team_b;
        row.status = 'done';
      } else if (match?.status === 'cancelled') {
        row.status = 'blocked';
        await notifyStaff(`🏆 Tournoi **${tournament.name}** : un match a été annulé, désigne le vainqueur dans l’admin (onglet Tournoi).\n${config.siteUrl}${PAGE}`);
      }
    }
  }

  const advanced = advanceBracket(rows.map(toEntry), rounds);
  for (const [index, entry] of advanced.entries()) {
    const row = rows[index]!;
    if (entry.teamA !== row.team_a || entry.teamB !== row.team_b || entry.winner !== row.winner || entry.status !== row.status) {
      unwrap(await supabase.from('tournament_bracket').update({ team_a: entry.teamA, team_b: entry.teamB, winner: entry.winner, status: entry.status }).eq('id', row.id));
    }
  }

  // Rencontres prêtes : match créé (maps tirées au sort, format de la rencontre).
  for (const entry of readyEntries(advanced)) {
    const row = rows.find((r) => r.round === entry.round && r.slot === entry.slot)!;
    const bestOf = bestOfFor(entry.round, rounds, formatOf(tournament), entry.slot);
    const { data, error } = await supabase.rpc('tournament_create_match', { p_entry: row.id, p_maps: pickMaps(config.cod.maps, bestOf), p_mode: config.cod.modes[0], p_best_of: bestOf });
    if (error) {
      console.error('[tournoi] création du match impossible', error.message);
      continue;
    }
    const match = data as { id: string; roster_a: string[]; roster_b: string[] } | null;
    if (!match?.id) continue;
    await pushToUsers([...match.roster_a, ...match.roster_b], {
      title: `🏆 ${isThirdPlace(entry, rounds) ? 'Petite finale' : roundName(entry.round, rounds)} : à vous de jouer`,
      body: `${tournament.name} · BO${bestOf}. Ouvre la feuille de match.`,
      url: `/cod/equipes/match/${match.id}`,
      tag: `team-match-${match.id}`,
      urgent: true,
    });
  }

  const result = podium(advanced, rounds);
  if (result) await completeTournament(tournament, result.winner, result.finalist, result.third);
}

async function completeTournament(tournament: TournamentRow, winner: string | null, finalist: string | null, third: string | null = null): Promise<void> {
  if (tournament.kind === 'horus') return completeCup(tournament, winner, finalist, third);
  const claimed = unwrap(
    await supabase
      .from('tournaments')
      .update({ status: 'completed', winner_team: winner, finalist_team: finalist, completed_at: new Date().toISOString() })
      .eq('id', tournament.id)
      .eq('status', 'running')
      .select('id')
      .maybeSingle(),
  );
  if (!claimed) return;
  const date = new Date().toISOString();
  for (const [teamId, place] of [[winner, 'winner'], [finalist, 'finalist']] as const) {
    if (!teamId) continue;
    const team = unwrap(await supabase.from('teams').select('trophies').eq('id', teamId).single()) as { trophies: unknown[] };
    const trophy = { tournamentId: tournament.id, name: tournament.name, season: tournament.season_id, place, date };
    unwrap(await supabase.from('teams').update({ trophies: [...(team.trophies ?? []), trophy] }).eq('id', teamId));
  }
  const participants = await participantsOf(tournament.id);
  const winnerRoster = participants.find((p) => p.team_id === winner)?.frozen_roster ?? [];
  const names = winner ? ((unwrap(await supabase.from('teams').select('id, name, tag').in('id', [winner, finalist].filter(Boolean) as string[])) ?? []) as { id: string; name: string; tag: string }[]) : [];
  const winnerTeam = names.find((team) => team.id === winner);
  await pushToUsers(participants.flatMap((p) => p.frozen_roster), {
    title: `🏆 ${tournament.name} : ${winnerTeam ? `victoire de ${winnerTeam.name}` : 'terminé'}`,
    body: 'Le tableau final est en ligne.',
    url: PAGE,
    tag: `tournoi-${tournament.id}`,
  });
  if (winnerTeam) {
    await announce(`🏆 **${tournament.name}** : victoire de **[${winnerTeam.tag}] ${winnerTeam.name}** ! Félicitations.\n${config.siteUrl}${PAGE}`);
    await giveWinnerRole(tournament, winnerRoster);
  }
}

/** Rôle Discord « Vainqueur — <tournoi> » pour l'effectif figé de l'équipe gagnante (créé s'il manque). */
async function giveWinnerRole(tournament: TournamentRow, roster: string[]): Promise<void> {
  if (!discordEnabled || !config.teams.discord || roster.length === 0) return;
  const { guildId } = config.discord;
  try {
    const name = `Vainqueur — ${tournament.name}`.slice(0, 100);
    const roles = (await discord(`/guilds/${guildId}/roles`)) as { id: string; name: string }[];
    const role = roles.find((r) => r.name === name) ?? ((await discord(`/guilds/${guildId}/roles`, { method: 'POST', body: { name, color: 0xd4af37, hoist: true } })) as { id: string });
    for (const discordId of (await discordIds(roster)).values()) {
      await discord(`/guilds/${guildId}/members/${discordId}/roles/${role.id}`, { method: 'PUT' }).catch(() => undefined);
    }
  } catch (caught) {
    console.warn('[tournoi] rôle Discord du vainqueur impossible', (caught as Error).message);
  }
}

async function announce(content: string, kind: Kind = 'saison'): Promise<void> {
  const channel = (kind === 'horus' && config.discord.divisionChannelId) || config.discord.codChannelId || config.discord.resultsChannelId;
  if (!discordEnabled || !config.teams.discord || !channel) return;
  await discord(`/channels/${channel}/messages`, { method: 'POST', body: { content, flags: SUPPRESS_EMBEDS } }).catch((caught) =>
    console.warn('[tournoi] annonce impossible', (caught as Error).message),
  );
}

// --- Coupe Horus : fin, récompenses ------------------------------------------------------------

/** Fin d'une Coupe Horus : trophées or / argent / bronze, points de Division, rôle Discord, annonces. */
async function completeCup(tournament: TournamentRow, winner: string | null, finalist: string | null, third: string | null): Promise<void> {
  const claimed = unwrap(
    await supabase
      .from('tournaments')
      .update({ status: 'completed', winner_team: winner, finalist_team: finalist, third_team: third, completed_at: new Date().toISOString() })
      .eq('id', tournament.id)
      .eq('status', 'running')
      .select('id')
      .maybeSingle(),
  );
  if (!claimed) return;
  const date = new Date().toISOString();
  const podiumPlaces = [
    [winner, 'or', CUP_BONUS.or],
    [finalist, 'argent', CUP_BONUS.argent],
    [third, 'bronze', CUP_BONUS.bronze],
  ] as const;
  for (const [teamId, place] of podiumPlaces) {
    if (!teamId) continue;
    const team = unwrap(await supabase.from('teams').select('trophies').eq('id', teamId).single()) as { trophies: unknown[] };
    const trophy = { tournamentId: tournament.id, kind: 'horus', name: tournament.name, season: tournament.season_id, place, date };
    unwrap(await supabase.from('teams').update({ trophies: [...(team.trophies ?? []), trophy] }).eq('id', teamId));
  }
  // Points de Division : podium, et participation pour les autres équipes présentes.
  const participants = (await participantsOf(tournament.id)).filter((p) => !p.forfeit);
  for (const p of participants) {
    const placed = podiumPlaces.find(([teamId]) => teamId === p.team_id);
    const points = placed ? placed[2] : CUP_BONUS.participation;
    const reason = placed ? `${tournament.name} · ${placed[1]}` : `${tournament.name} · participation`;
    const { error } = await supabase.rpc('team_add_bonus', { p_team: p.team_id, p_tournament: tournament.id, p_points: points, p_reason: reason });
    if (error) console.error('[coupe] bonus impossible', error.message);
  }
  const names = (unwrap(await supabase.from('teams').select('id, name, tag').in('id', [winner, finalist, third].filter(Boolean) as string[])) ?? []) as {
    id: string;
    name: string;
    tag: string;
  }[];
  const label = (teamId: string | null) => {
    const team = names.find((t) => t.id === teamId);
    return team ? `[${team.tag}] ${team.name}` : '—';
  };
  await pushToUsers(participants.flatMap((p) => p.match_roster ?? p.frozen_roster), {
    title: `🏆 ${tournament.name} : victoire de ${label(winner)}`,
    body: 'Le tableau final et les trophées sont en ligne.',
    url: PAGE,
    tag: `tournoi-${tournament.id}`,
  });
  await announce(
    `🏆 **${tournament.name}** terminée !\n🥇 ${label(winner)} (+${CUP_BONUS.or} pts)\n🥈 ${label(finalist)} (+${CUP_BONUS.argent} pts)${third ? `\n🥉 ${label(third)} (+${CUP_BONUS.bronze} pts)` : ''}\n${config.siteUrl}${PAGE}`,
    tournament.kind,
  );
  const winnerEntry = participants.find((p) => p.team_id === winner);
  if (winnerEntry) await passHorusRole(winnerEntry.match_roster ?? winnerEntry.frozen_roster);
}

/** Rôle « Vainqueur — Coupe Horus » : retiré aux vainqueurs précédents, donné aux nouveaux (gardé jusqu'à la coupe suivante). */
async function passHorusRole(roster: string[]): Promise<void> {
  if (!discordEnabled || !config.teams.discord) return;
  const { guildId } = config.discord;
  try {
    const roles = (await discord(`/guilds/${guildId}/roles`)) as { id: string; name: string }[];
    const role = roles.find((r) => r.name === HORUS_ROLE) ?? ((await discord(`/guilds/${guildId}/roles`, { method: 'POST', body: { name: HORUS_ROLE, color: 0xd4af37, hoist: true } })) as { id: string });
    const state = unwrap(await supabase.from('app_state').select('value').eq('key', 'horus_role_holders').maybeSingle()) as { value: string } | null;
    const previous = state ? (JSON.parse(state.value) as string[]) : [];
    for (const discordId of (await discordIds(previous.filter((id) => !roster.includes(id)))).values()) {
      await discord(`/guilds/${guildId}/members/${discordId}/roles/${role.id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    for (const discordId of (await discordIds(roster)).values()) {
      await discord(`/guilds/${guildId}/members/${discordId}/roles/${role.id}`, { method: 'PUT' }).catch(() => undefined);
    }
    unwrap(await supabase.from('app_state').upsert({ key: 'horus_role_holders', value: JSON.stringify(roster) }));
  } catch (caught) {
    console.warn('[coupe] rôle Discord impossible', (caught as Error).message);
  }
}

// --- Coupe Horus : rendez-vous récurrents -------------------------------------------------------

interface ScheduleRow {
  id: string;
  name: string;
  weekday: number;
  start_time: string;
  size: number;
  best_of: number;
  final_best_of: number;
  active: boolean;
  last_date: string | null;
  created_by: string | null;
}

/** Décalage de Paris (minutes) à un instant donné. */
function parisOffset(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** Instant UTC d'une date (AAAA-MM-JJ) et heure (HH:MM) de Paris. */
function parisInstant(day: string, time: string): Date {
  const guess = new Date(`${day}T${time.slice(0, 5)}:00Z`);
  return new Date(guess.getTime() - parisOffset(guess) * 60_000);
}

/** Prochaine date du rendez-vous (jour de la semaine, heure de Paris), au moins 35 min plus tard. */
export function nextOccurrence(weekday: number, time: string, now = Date.now()): { day: string; startsAt: Date } {
  for (let k = 0; k <= 7; k += 1) {
    const day = new Date(now + k * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    const startsAt = parisInstant(day, time);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === weekday && startsAt.getTime() > now + (CHECKIN_MINUTES + 5) * 60_000) return { day, startsAt };
  }
  const day = new Date(now + 7 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  return { day, startsAt: parisInstant(day, time) };
}

async function cupsAuto(): Promise<boolean> {
  const row = unwrap(await supabase.from('app_state').select('value').eq('key', 'cups_auto').maybeSingle()) as { value: string } | null;
  return row?.value === 'on';
}

/** Coupes automatiques : chaque rendez-vous actif a sa prochaine coupe ouverte aux inscriptions. */
async function ensureScheduledCups(): Promise<void> {
  if (!config.teams.enabled || !(await cupsAuto())) return;
  const schedules = (unwrap(await supabase.from('cup_schedules').select('*').eq('active', true)) ?? []) as ScheduleRow[];
  for (const schedule of schedules) {
    const { count } = await supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('schedule_id', schedule.id).in('status', ['scheduled', 'running']);
    if ((count ?? 0) > 0) continue;
    const next = nextOccurrence(schedule.weekday, schedule.start_time);
    if (schedule.last_date === next.day) continue;
    await openCup({ name: schedule.name, size: schedule.size, bestOf: schedule.best_of, finalBestOf: schedule.final_best_of, startsAt: next.startsAt, scheduleId: schedule.id, adminId: schedule.created_by });
    unwrap(await supabase.from('cup_schedules').update({ last_date: next.day }).eq('id', schedule.id));
  }
}

async function openCup(input: { name: string; size: number; bestOf: number; finalBestOf: number; startsAt: Date; scheduleId: string | null; adminId: string | null }) {
  const season = unwrap(await supabase.from('seasons').select('id').eq('is_active', true).maybeSingle()) as { id: number } | null;
  const tournament = unwrap(
    await supabase
      .from('tournaments')
      .insert({
        kind: 'horus',
        name: input.name,
        size: input.size,
        best_of: input.bestOf,
        final_best_of: input.finalBestOf,
        third_place: true,
        starts_at: input.startsAt.toISOString(),
        season_id: season?.id ?? null,
        schedule_id: input.scheduleId,
        created_by: input.adminId,
      })
      .select('*')
      .single(),
  ) as TournamentRow;
  const date = input.startsAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  await announce(
    `🏆 **${input.name}** : inscriptions ouvertes ! ${input.size} équipes max, BO${input.bestOf} (finale BO${input.finalBestOf}), ${date}. Check-in ${CHECKIN_MINUTES} min avant.\n${config.siteUrl}${PAGE}`,
    'horus',
  );
  return tournament;
}

// --- Coupe Horus : administration ------------------------------------------------------------

function parseCupInput(body: unknown) {
  const input = (body ?? {}) as { name?: unknown; size?: unknown; bestOf?: unknown; finalBestOf?: unknown };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length < 3 || name.length > 60) throw new HttpError(400, 'INVALID_CUP', 'Le nom de la coupe fait entre 3 et 60 caractères.');
  const size = Number(input.size);
  if (!(CUP_SIZES as readonly number[]).includes(size)) throw new HttpError(400, 'INVALID_CUP', 'Nombre d’équipes : 4, 8 ou 16.');
  const bestOf = Number(input.bestOf);
  if (bestOf !== 1 && bestOf !== 3) throw new HttpError(400, 'INVALID_CUP', 'Matchs en BO1 ou BO3.');
  const finalBestOf = Number(input.finalBestOf);
  if (!(bestOf === 1 ? [3] : [3, 5]).includes(finalBestOf)) throw new HttpError(400, 'INVALID_CUP', bestOf === 1 ? 'En BO1, la finale se joue en BO3.' : 'Finale en BO3 ou BO5.');
  return { name, size, bestOf, finalBestOf };
}

export async function cupAdmin() {
  const [auto, schedules, cups] = await Promise.all([
    cupsAuto(),
    supabase.from('cup_schedules').select('*').order('created_at'),
    supabase.from('tournaments').select('*').eq('kind', 'horus').order('starts_at', { ascending: false }).limit(10),
  ]);
  return {
    auto,
    schedules: ((schedules.data ?? []) as ScheduleRow[]).map((row) => ({
      id: row.id,
      name: row.name,
      weekday: row.weekday,
      time: row.start_time.slice(0, 5),
      size: row.size,
      bestOf: row.best_of,
      finalBestOf: row.final_best_of,
      active: row.active,
      next: nextOccurrence(row.weekday, row.start_time).startsAt.toISOString(),
    })),
    cups: ((cups.data ?? []) as TournamentRow[]).map((row) => ({ id: row.id, name: row.name, size: row.size, startsAt: row.starts_at, status: row.status, bestOf: row.best_of, finalBestOf: row.final_best_of })),
  };
}

export async function setCupsAuto(body: unknown) {
  const on = Boolean((body as { on?: unknown } | undefined)?.on);
  unwrap(await supabase.from('app_state').upsert({ key: 'cups_auto', value: on ? 'on' : 'off' }));
  if (on) await ensureScheduledCups();
  return cupAdmin();
}

function parseSchedule(body: unknown) {
  const base = parseCupInput(body);
  const input = (body ?? {}) as { weekday?: unknown; time?: unknown };
  const weekday = Number(input.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new HttpError(400, 'INVALID_CUP', 'Jour invalide.');
  const time = typeof input.time === 'string' && /^\d{2}:\d{2}$/.test(input.time) ? input.time : null;
  if (!time) throw new HttpError(400, 'INVALID_CUP', 'Heure invalide (HH:MM).');
  return { ...base, weekday, time };
}

export async function createSchedule(adminId: string, body: unknown) {
  const input = parseSchedule(body);
  unwrap(
    await supabase.from('cup_schedules').insert({
      name: input.name,
      weekday: input.weekday,
      start_time: input.time,
      size: input.size,
      best_of: input.bestOf,
      final_best_of: input.finalBestOf,
      created_by: adminId,
    }),
  );
  await ensureScheduledCups();
  return cupAdmin();
}

export async function updateSchedule(id: string, body: unknown) {
  const patch = body as { active?: unknown } | undefined;
  if (typeof patch?.active === 'boolean' && Object.keys(patch).length === 1) {
    unwrap(await supabase.from('cup_schedules').update({ active: patch.active }).eq('id', id));
  } else {
    const input = parseSchedule(body);
    unwrap(
      await supabase
        .from('cup_schedules')
        .update({ name: input.name, weekday: input.weekday, start_time: input.time, size: input.size, best_of: input.bestOf, final_best_of: input.finalBestOf, last_date: null })
        .eq('id', id),
    );
  }
  await ensureScheduledCups();
  return cupAdmin();
}

export async function deleteSchedule(id: string) {
  unwrap(await supabase.from('cup_schedules').delete().eq('id', id));
  return cupAdmin();
}

/** Coupe ponctuelle (date et heure choisies par l'admin). */
export async function createCup(adminId: string, body: unknown) {
  if (!config.teams.enabled) throw new HttpError(403, 'TEAM_MODE_PAUSED', 'La Division est en pause.');
  const input = parseCupInput(body);
  const startsAt = new Date(typeof (body as { startsAt?: unknown })?.startsAt === 'string' ? (body as { startsAt: string }).startsAt : '');
  if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'INVALID_CUP', 'Date de début invalide.');
  if (startsAt.getTime() < Date.now() + (CHECKIN_MINUTES + 5) * 60_000) throw new HttpError(400, 'INVALID_CUP', `La coupe doit commencer dans plus de ${CHECKIN_MINUTES + 5} min.`);
  await openCup({ ...input, startsAt, scheduleId: null, adminId });
  return cupAdmin();
}
