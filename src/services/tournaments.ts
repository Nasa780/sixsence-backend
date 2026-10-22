import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { postAnnouncement } from './announcements.js';
import { SUPPRESS_EMBEDS, discord, discordEnabled, discordIds, dm, notifyStaff } from './discord.js';
import { pushToUsers } from './push.js';
import { openMatchVoice } from './teamMatches.js';
import { pickMaps } from './teamMatchPolicy.js';
import { membershipOf } from './teams.js';
import {
  ANUBIS_TEAMS,
  ANUBIS_TEAM_SIZES,
  BUSY_MINUTES,
  CHECKIN_MINUTES,
  CHECKIN_REMINDERS,
  CHECKIN_TEXT,
  REVEAL_MINUTES,
  CUP_BONUS,
  CUP_MIN_TEAMS,
  CUP_SIZES,
  GRAND_FINAL,
  LOSERS_BASE,
  QUALIFY_MATCHES,
  TOURNAMENT_SIZES,
  advanceBracket,
  advanceDouble,
  anubisCapacity,
  bestOfDouble,
  bestOfFor,
  bracketSizeFor,
  doubleBracket,
  emptyRounds,
  firstRound,
  formTeams,
  isThirdPlace,
  podium,
  podiumDouble,
  qualifiedTeams,
  readyEntries,
  roundName,
  roundNameDouble,
  roundsFor,
  shuffle,
  type BracketEntry,
  type BracketType,
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
 *
 * Coupe Anubis (kind 'anubis', migration 0040) : inscription individuelle (cup_players), check-in de chaque
 * joueur 30 min avant, puis équipes formées au hasard à la taille choisie par l'admin (team_size), remplaçants
 * répartis, capitaine = le mieux classé (formTeams). Équipes temporaires (teams.cup_tournament, créées
 * dissoutes : jamais au classement). Même tableau et même déroulé que la Coupe Horus ; récompenses :
 * médailles or / argent / bronze pour les joueurs (cup_medals) et rôle « Vainqueur — Coupe Anubis » ; pas de points.
 */

type Kind = 'saison' | 'horus' | 'anubis';
/** Coupes à inscription libre (Horus : équipes, Anubis : joueurs). */
const isCup = (kind: Kind) => kind !== 'saison';

interface TournamentRow {
  id: string;
  season_id: number | null;
  kind: Kind;
  best_of: number;
  final_best_of: number;
  third_place: boolean;
  bracket: BracketType;
  third_team: string | null;
  team_size: number | null;
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
  captain: string | null;
}

interface CupPlayerRow {
  tournament_id: string;
  user_id: string;
  registered_at: string;
  checked_in_at: string | null;
  team_id: string | null;
}

const PAGE = '/cod/tournoi';
const CUP_ROLES = {
  horus: { name: 'Vainqueur — Coupe Horus', key: 'horus_role_holders', color: 0xd4af37 },
  anubis: { name: 'Vainqueur — Coupe Anubis', key: 'anubis_role_holders', color: 0x7f5af0 },
} as const;
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
  if (startsAt.getTime() < Date.now() + (REVEAL_MINUTES + 5) * 60_000) throw new HttpError(400, 'INVALID_TOURNAMENT', `Le tournoi doit commencer dans plus de ${REVEAL_MINUTES + 5} min.`);
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
    body: `Début ${date}. Check-in d’un Leader de 2 h à 15 min avant.`,
    url: PAGE,
    tag: `tournoi-${tournament.id}`,
  });
  await announce(`🏆 **${name}** — ${qualified.length} équipes qualifiées, début ${date} (${CHECKIN_TEXT}).\n${config.siteUrl}${PAGE}`);
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
  const display =
    tournament.status === 'scheduled'
      ? tournament.bracket === 'double'
        ? advanceDouble(rows.map(toEntry), tournament.size)
        : advanceBracket(rows.map(toEntry), rounds)
      : rows.map(toEntry);
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

  if (tournament.kind === 'anubis') return { ...publicView(), ...(await anubisView(tournament, participants, card, viewerId)) };
  return { ...publicView(), viewer };

  function publicView() {
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
    checkInClosesAt: new Date(revealTime(tournament)).toISOString(),
    completedAt: tournament.completed_at,
    winner: card(tournament.winner_team),
    finalist: card(tournament.finalist_team),
    teams: participants.map((p) => ({ ...card(p.team_id)!, checkedIn: Boolean(p.checked_in_at), forfeit: p.forfeit })),
    bracket: tournament.bracket,
    rounds: Array.from({ length: rounds }, (_, index) => {
      const round = index + 1;
      const double = tournament.bracket === 'double';
      return {
        round,
        name: double ? roundNameDouble(round, tournament.size) : roundName(round, rounds),
        bestOf: double ? bestOfDouble(round, formatOf(tournament)) : bestOfFor(round, rounds, formatOf(tournament)),
        entries: display.filter((entry) => entry.round === round && !isThirdPlace(entry, rounds)).map(present),
      };
    }),
    losers:
      tournament.bracket === 'double'
        ? Array.from({ length: 2 * (rounds - 1) }, (_, index) => {
            const round = LOSERS_BASE + index + 1;
            return {
              round,
              name: roundNameDouble(round, tournament.size),
              bestOf: bestOfDouble(round, formatOf(tournament)),
              entries: display.filter((entry) => entry.round === round).map(present),
            };
          })
        : null,
    grandFinal:
      tournament.bracket === 'double'
        ? (() => {
            const entry = display.find((e) => e.round === GRAND_FINAL);
            return entry ? { name: 'Grande finale', bestOf: tournament.final_best_of, entry: present(entry) } : null;
          })()
        : null,
  };
  }
}

type Card = { id: string; name: string; tag: string; color: string; logoUrl: string | null; seed: number | null } | null;

/** Coupe Anubis : joueurs inscrits, équipes formées (capitaine, titulaires, remplaçants) et droits du visiteur. */
async function anubisView(tournament: TournamentRow, participants: ParticipantRow[], card: (teamId: string | null) => Card, viewerId: string | null) {
  const players = (unwrap(await supabase.from('cup_players').select('*').eq('tournament_id', tournament.id).order('registered_at')) ?? []) as CupPlayerRow[];
  const ids = [...new Set([...players.map((p) => p.user_id), ...participants.flatMap((p) => p.frozen_roster)])];
  const people = await playersInfo(ids);
  const person = (id: string) => people.get(id) ?? { id, username: 'Joueur', avatarUrl: null, points: 0 };
  const teamSize = tournament.team_size ?? config.teams.rosterSize;
  const capacity = anubisCapacity(tournament.size, teamSize);
  const open = tournament.status === 'scheduled' && Date.now() < new Date(tournament.starts_at).getTime();
  const squads = participants.map((p) => {
    const starters = p.match_roster ?? p.frozen_roster.slice(0, teamSize);
    return {
      team: card(p.team_id),
      captain: p.captain,
      forfeit: p.forfeit,
      starters: starters.map(person),
      subs: p.frozen_roster.filter((id) => !starters.includes(id)).map(person),
    };
  });

  let viewer = null;
  if (viewerId) {
    const me = players.find((p) => p.user_id === viewerId);
    const squad = participants.find((p) => p.frozen_roster.includes(viewerId));
    const eliminated = squad ? await teamEliminated(tournament, squad.team_id) : false;
    viewer = {
      solo: true,
      registered: Boolean(me),
      checkedIn: Boolean(me?.checked_in_at),
      canRegister: !me && open && players.length < capacity,
      canUnregister: Boolean(me) && open,
      canCheckIn: Boolean(me) && !me?.checked_in_at && tournament.status === 'scheduled' && checkInOpen(tournament),
      teamId: squad?.team_id ?? null,
      isCaptain: Boolean(squad && squad.captain === viewerId),
      canSetRoster: Boolean(squad && squad.captain === viewerId && tournament.status === 'running' && !eliminated && squad.frozen_roster.length > teamSize),
    };
  }
  return {
    teamSize,
    capacity,
    registered: players.length,
    checkedInCount: players.filter((p) => p.checked_in_at).length,
    players: players.map((p) => ({ ...person(p.user_id), checkedIn: Boolean(p.checked_in_at) })),
    squads,
    viewer,
  };
}

async function playersInfo(ids: string[]) {
  if (ids.length === 0) return new Map<string, { id: string; username: string; avatarUrl: string | null; points: number }>();
  const [users, profiles] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').in('id', ids),
    supabase.from('cod_profiles').select('user_id, points').in('user_id', ids),
  ]);
  const points = new Map(((profiles.data ?? []) as { user_id: string; points: number }[]).map((row) => [row.user_id, row.points]));
  return new Map(
    ((users.data ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((user) => [
      user.id,
      { id: user.id, username: user.username, avatarUrl: user.avatar_url, points: points.get(user.id) ?? 0 },
    ]),
  );
}

/** Équipe éliminée : battue dans le tableau (une fois en élimination directe, deux fois en double élimination). */
async function teamEliminated(tournament: TournamentRow, teamId: string): Promise<boolean> {
  if (tournament.status !== 'running') return true;
  const losses = (await entriesOf(tournament.id)).filter((e) => e.status === 'done' && (e.team_a === teamId || e.team_b === teamId) && e.winner && e.winner !== teamId);
  return losses.length >= (tournament.bracket === 'double' ? 2 : 1);
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

/** Fin du check-in et tirage dévoilé (15 min avant le début). */
const revealTime = (tournament: Pick<TournamentRow, 'starts_at'>) => new Date(tournament.starts_at).getTime() - REVEAL_MINUTES * 60_000;
const checkInOpen = (tournament: TournamentRow) => {
  const start = new Date(tournament.starts_at).getTime();
  return Date.now() >= start - CHECKIN_MINUTES * 60_000 && Date.now() < revealTime(tournament);
};

// --- Check-in -----------------------------------------------------------------------------

/** Check-in d'un Leader : joueurs du match choisis parmi l'effectif figé (modifiables jusqu'au début). */
export async function checkIn(userId: string, id: string, body: unknown) {
  const tournament = await tournamentRow(id);
  if (tournament.kind === 'anubis') return checkInPlayer(userId, id);
  if (tournament.status !== 'scheduled') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'Le check-in est fermé.');
  if (!checkInOpen(tournament)) throw new HttpError(409, 'CHECKIN_CLOSED', 'Le check-in est ouvert de 2 h à 15 min avant le début du tournoi.');
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

/** Coupe Horus : un Leader inscrit son équipe (places limitées, jusqu'au début). Coupe Anubis : le joueur s'inscrit. */
export async function registerTeam(userId: string, id: string) {
  const tournament = await tournamentRow(id);
  if (tournament.kind === 'anubis') return registerPlayer(userId, tournament);
  if (tournament.kind !== 'horus') throw new HttpError(409, 'NOT_A_CUP', 'Ce tournoi se joue sur qualification.');
  if (tournament.status !== 'scheduled' || Date.now() >= revealTime(tournament)) throw new HttpError(409, 'REGISTRATION_CLOSED', 'Les inscriptions sont fermées.');
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

/** Coupe Horus : un Leader désinscrit son équipe (jusqu'au début). Coupe Anubis : le joueur se désinscrit. */
export async function unregisterTeam(userId: string, id: string) {
  const tournament = await tournamentRow(id);
  if (tournament.kind === 'anubis') {
    if (tournament.status !== 'scheduled' || Date.now() >= revealTime(tournament)) throw new HttpError(409, 'REGISTRATION_CLOSED', 'La coupe a commencé.');
    unwrap(await supabase.from('cup_players').delete().eq('tournament_id', id).eq('user_id', userId));
    return getTournament(id, userId);
  }
  if (tournament.kind !== 'horus') throw new HttpError(409, 'NOT_A_CUP', 'Ce tournoi se joue sur qualification.');
  if (tournament.status !== 'scheduled' || Date.now() >= revealTime(tournament)) throw new HttpError(409, 'REGISTRATION_CLOSED', 'La coupe a commencé.');
  const member = await membershipOf(userId);
  if (!member || !(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut désinscrire l’équipe.');
  unwrap(await supabase.from('tournament_teams').delete().eq('tournament_id', id).eq('team_id', member.team_id));
  return getTournament(id, userId);
}

// --- Coupe Anubis : inscription individuelle ------------------------------------------------------

async function registerPlayer(userId: string, tournament: TournamentRow) {
  if (tournament.status !== 'scheduled' || Date.now() >= revealTime(tournament)) throw new HttpError(409, 'REGISTRATION_CLOSED', 'Les inscriptions sont fermées.');
  const profile = unwrap(await supabase.from('cod_profiles').select('activision_id, banned_until').eq('user_id', userId).maybeSingle()) as {
    activision_id: string | null;
    banned_until: string | null;
  } | null;
  if (!profile?.activision_id) throw new HttpError(409, 'ACTIVISION_REQUIRED', 'Renseigne ton identifiant Activision sur ton profil pour t’inscrire.');
  if (profile.banned_until && new Date(profile.banned_until).getTime() > Date.now()) throw new HttpError(403, 'BANNED', 'Tu es exclu en ce moment.');
  const { count, error } = await supabase.from('cup_players').select('user_id', { count: 'exact', head: true }).eq('tournament_id', tournament.id);
  if (error) throw fromDbError(error);
  const capacity = anubisCapacity(tournament.size, tournament.team_size ?? config.teams.rosterSize);
  if ((count ?? 0) >= capacity) throw new HttpError(409, 'CUP_FULL', 'La coupe est complète.');
  const { error: insertError } = await supabase.from('cup_players').insert({ tournament_id: tournament.id, user_id: userId });
  if (insertError && insertError.code !== '23505') throw fromDbError(insertError);
  const left = capacity - (count ?? 0) - 1;
  if (left === 1 || left === 0) await announce(`𓂀 **${tournament.name}** : ${left === 0 ? 'complète !' : 'plus qu’une place !'}\n${config.siteUrl}${PAGE}?coupe=anubis`, tournament.kind);
  return getTournament(tournament.id, userId);
}

/** Check-in d'un joueur inscrit (30 min avant le début). */
async function checkInPlayer(userId: string, id: string) {
  const tournament = await tournamentRow(id);
  if (tournament.status !== 'scheduled') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'Le check-in est fermé.');
  if (!checkInOpen(tournament)) throw new HttpError(409, 'CHECKIN_CLOSED', 'Le check-in est ouvert de 2 h à 15 min avant le début de la coupe.');
  const row = unwrap(
    await supabase.from('cup_players').update({ checked_in_at: new Date().toISOString() }).eq('tournament_id', id).eq('user_id', userId).is('checked_in_at', null).select('user_id').maybeSingle(),
  );
  if (!row) {
    const { count } = await supabase.from('cup_players').select('user_id', { count: 'exact', head: true }).eq('tournament_id', id).eq('user_id', userId);
    if (!count) throw new HttpError(403, 'NOT_REGISTERED', 'Tu n’es pas inscrit à cette coupe.');
  }
  return getTournament(id, userId);
}

/** Capitaine d'une équipe formée : titulaires des prochains matchs (remplaçant qui entre, titulaire qui sort). */
export async function setSquadRoster(userId: string, id: string, body: unknown) {
  const tournament = await tournamentRow(id);
  if (tournament.kind !== 'anubis' || tournament.status !== 'running') throw new HttpError(409, 'TOURNAMENT_NOT_RUNNING', 'La coupe n’est pas en cours.');
  const squad = (await participantsOf(id)).find((p) => p.captain === userId);
  if (!squad) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul le capitaine choisit les titulaires.');
  const size = tournament.team_size ?? config.teams.rosterSize;
  const roster = (body as { roster?: unknown } | undefined)?.roster;
  if (!Array.isArray(roster) || roster.length !== size || new Set(roster).size !== size || !roster.every((rid) => squad.frozen_roster.includes(rid))) {
    throw new HttpError(400, 'INVALID_ROSTER', `Choisis ${size} titulaire${size > 1 ? 's' : ''} dans ton équipe.`);
  }
  unwrap(await supabase.from('tournament_teams').update({ match_roster: roster }).eq('tournament_id', id).eq('team_id', squad.team_id));
  return getTournament(id, userId);
}

/** Équipe encore en lice dans un tournoi en cours ou prévu (elle ne peut pas lancer de match ordinaire). */
export async function teamBusyInTournament(teamId: string): Promise<boolean> {
  const rows = (unwrap(await supabase.from('tournament_teams').select('tournament_id, forfeit').eq('team_id', teamId)) ?? []) as { tournament_id: string; forfeit: boolean }[];
  for (const row of rows) {
    if (row.forfeit) continue;
    const tournament = unwrap(await supabase.from('tournaments').select('status, starts_at').eq('id', row.tournament_id).single()) as { status: string; starts_at: string };
    // 1 h avant le début, l'équipe se réserve pour le tournoi (un match ordinaire n'empiéterait pas dessus).
    if (tournament.status === 'scheduled') {
      if (Date.now() >= new Date(tournament.starts_at).getTime() - BUSY_MINUTES * 60_000) return true;
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

/** Tâche toutes les minutes : rappels du check-in, tirage 15 min avant le début, puis avancement des tableaux. */
export async function sweepTournaments(): Promise<void> {
  try {
    await checkInReminders();
    const due = (unwrap(await supabase.from('tournaments').select('*').eq('status', 'scheduled').lte('starts_at', new Date(Date.now() + REVEAL_MINUTES * 60_000).toISOString())) ?? []) as TournamentRow[];
    for (const tournament of due) await startTournament(tournament);
    const running = (unwrap(await supabase.from('tournaments').select('id').eq('status', 'running')) ?? []) as { id: string }[];
    for (const row of running) await advanceTournament(row.id);
    await ensureScheduledCups();
  } catch (caught) {
    console.error('[tournoi] tâche impossible', (caught as Error).message);
  }
}

const hourOf = (tournament: Pick<TournamentRow, 'starts_at'>) =>
  new Date(tournament.starts_at).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

/**
 * Rappels du check-in (push et message privé) : à l'ouverture (2 h avant) à tous les inscrits, avec une annonce
 * Discord ; puis 1 h et 30 min avant, seulement à ceux qui ne l'ont pas fait. Une fois par étape (app_claim).
 */
async function checkInReminders(): Promise<void> {
  const now = Date.now();
  const soon = (unwrap(
    await supabase.from('tournaments').select('*').eq('status', 'scheduled').gt('starts_at', new Date(now + REVEAL_MINUTES * 60_000).toISOString()).lte('starts_at', new Date(now + CHECKIN_MINUTES * 60_000).toISOString()),
  ) ?? []) as TournamentRow[];
  for (const tournament of soon) {
    const left = (new Date(tournament.starts_at).getTime() - now) / 60_000;
    const stage = CHECKIN_REMINDERS.filter((minutes) => left <= minutes).at(-1);
    const step = stage === undefined ? 'open' : String(stage);
    const { data: claimed } = await supabase.rpc('app_claim', { p_key: `checkin_${tournament.id}`, p_value: step });
    if (!claimed) continue;
    const closes = new Date(revealTime(tournament)).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    const url = tournament.kind === 'anubis' ? `${PAGE}?coupe=anubis` : tournament.kind === 'saison' ? `${PAGE}?coupe=saison` : PAGE;
    // Joueurs à prévenir : Anubis, chaque inscrit ; équipes, tout l'effectif (le check-in est fait par un Leader).
    let targets: string[];
    if (tournament.kind === 'anubis') {
      const players = (unwrap(await supabase.from('cup_players').select('user_id, checked_in_at').eq('tournament_id', tournament.id)) ?? []) as { user_id: string; checked_in_at: string | null }[];
      targets = players.filter((p) => step === 'open' || !p.checked_in_at).map((p) => p.user_id);
    } else {
      const teams = (await participantsOf(tournament.id)).filter((p) => step === 'open' || !p.checked_in_at);
      targets = [...new Set((await Promise.all(teams.map((p) => (tournament.kind === 'horus' ? teamMemberIds(p.team_id) : Promise.resolve(p.frozen_roster))))).flat())];
    }
    if (targets.length === 0) continue;
    const first = step === 'open';
    const text = first
      ? `Le check-in de ${tournament.name} est ouvert jusqu’à ${closes}. ${tournament.kind === 'anubis' ? 'Confirme ta présence' : 'Un Leader confirme l’équipe et choisit les joueurs'} : sans check-in, pas de place.`
      : `Dernier rappel : le check-in de ${tournament.name} ferme à ${closes}. ${tournament.kind === 'anubis' ? 'Confirme ta présence' : 'Un Leader doit valider l’équipe'} pour jouer.`;
    await pushToUsers(targets, { title: first ? '✅ Check-in ouvert' : '⏰ Check-in : plus que quelques minutes', body: text, url, tag: `checkin-${tournament.id}`, urgent: !first });
    if (discordEnabled && config.teams.discord) await dm(targets, `${first ? '✅' : '⏰'} ${text}\n${config.siteUrl}${url}`);
    if (first) await announce(`✅ **${tournament.name}** : check-in ouvert jusqu’à ${closes}, tirage à ${closes} et premiers matchs à ${hourOf(tournament)}.\n${config.siteUrl}${url}`, tournament.kind);
  }
}

/** Tirage (15 min avant) : équipes sans check-in déclarées forfait (retirées du 1er tour) ; 1ers matchs à l'heure du début. */
async function startTournament(tournament: TournamentRow): Promise<void> {
  if (tournament.kind === 'horus') return startCup(tournament);
  if (tournament.kind === 'anubis') return startAnubis(tournament);
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
  await announce(`🏆 **${tournament.name}** : check-in terminé${absent.length ? `, ${absent.length} équipe(s) forfait` : ''}. Premiers matchs à ${hourOf(tournament)} !\n${config.siteUrl}${PAGE}`);
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
  await drawBracket(tournament, drawn, size);
  await announce(`🏆 **${tournament.name}** : ${present.length} équipes, tableau tiré au sort ! Premiers matchs à ${hourOf(tournament)}.\n${config.siteUrl}${PAGE}`, tournament.kind);
  await advanceTournament(tournament.id);
}

async function drawBracket(tournament: TournamentRow, drawn: string[], size: number): Promise<void> {
  const bracket = tournament.bracket === 'double' ? doubleBracket(drawn, size) : [...firstRound(drawn, size), ...emptyRounds(size, tournament.third_place)];
  unwrap(
    await supabase
      .from('tournament_bracket')
      .insert(bracket.map((entry) => ({ tournament_id: tournament.id, round: entry.round, slot: entry.slot, team_a: entry.teamA, team_b: entry.teamB, status: entry.status }))),
  );
}

/**
 * Début d'une Coupe Anubis : équipes formées au hasard parmi les joueurs présents au check-in (capitaine,
 * remplaçants), équipes temporaires créées, tableau tiré au sort. Moins de 4 équipes complètes : annulée.
 */
async function startAnubis(tournament: TournamentRow): Promise<void> {
  const players = (unwrap(await supabase.from('cup_players').select('*').eq('tournament_id', tournament.id)) ?? []) as CupPlayerRow[];
  const present = players.filter((p) => p.checked_in_at);
  const teamSize = tournament.team_size ?? config.teams.rosterSize;
  const info = await playersInfo(present.map((p) => p.user_id));
  const formed = formTeams(present.map((p) => ({ id: p.user_id, points: info.get(p.user_id)?.points ?? 0 })), teamSize, tournament.size);
  if (formed.length < CUP_MIN_TEAMS) {
    const claimed = unwrap(
      await supabase.from('tournaments').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', tournament.id).eq('status', 'scheduled').select('id').maybeSingle(),
    );
    if (!claimed) return;
    await pushToUsers(players.map((p) => p.user_id), {
      title: `𓂀 ${tournament.name} annulée`,
      body: `Pas assez de joueurs présents au check-in (${present.length}, il en faut ${CUP_MIN_TEAMS * teamSize}).`,
      url: PAGE,
      tag: `tournoi-${tournament.id}`,
    });
    await announce(`𓂀 **${tournament.name}** annulée : pas assez de joueurs présents au check-in (${present.length}/${CUP_MIN_TEAMS * teamSize}).`, tournament.kind);
    return;
  }
  const size = bracketSizeFor(formed.length, tournament.size);
  const claimed = unwrap(
    await supabase.from('tournaments').update({ status: 'running', started_at: new Date().toISOString(), size }).eq('id', tournament.id).eq('status', 'scheduled').select('id').maybeSingle(),
  );
  if (!claimed) return;
  const now = new Date().toISOString();
  const teamIds: string[] = [];
  for (const [index, squad] of formed.entries()) {
    const base = ANUBIS_TEAMS[index % ANUBIS_TEAMS.length]!;
    const team = unwrap(
      await supabase
        .from('teams')
        .insert({ name: base.name, tag: base.tag, color: base.color, owner_id: squad.captain, disbanded_at: now, cup_tournament: tournament.id, description: tournament.name })
        .select('id')
        .single(),
    ) as { id: string };
    teamIds.push(team.id);
    unwrap(
      await supabase.from('tournament_teams').insert({
        tournament_id: tournament.id,
        team_id: team.id,
        seed: index + 1,
        frozen_roster: [...squad.starters, ...squad.subs],
        match_roster: squad.starters,
        checked_in_at: now,
        captain: squad.captain,
      }),
    );
    unwrap(await supabase.from('cup_players').update({ team_id: team.id }).eq('tournament_id', tournament.id).in('user_id', [...squad.starters, ...squad.subs]));
    await pushToUsers([...squad.starters, ...squad.subs], {
      title: `𓂀 ${tournament.name} : tu joues avec ${base.name} [${base.tag}]`,
      body: `Capitaine : ${info.get(squad.captain)?.username ?? 'tiré au sort'}. Rejoins ton équipe : premiers matchs à ${hourOf(tournament)}.`,
      url: `${PAGE}?coupe=anubis`,
      tag: `tournoi-${tournament.id}`,
      urgent: true,
    });
  }
  await drawBracket(tournament, teamIds, size);
  const placed = formed.reduce((total, squad) => total + squad.starters.length + squad.subs.length, 0);
  const benched = present.length - placed;
  await announce(
    `𓂀 **${tournament.name}** : ${formed.length} équipes de ${teamSize} tirées au sort parmi ${present.length} joueurs${benched > 0 ? ` (${benched} sans place)` : ''} ! Premiers matchs à ${hourOf(tournament)}.\n${config.siteUrl}${PAGE}?coupe=anubis`,
    tournament.kind,
  );
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

  const double = tournament.bracket === 'double';
  const advanced = double ? advanceDouble(rows.map(toEntry), tournament.size) : advanceBracket(rows.map(toEntry), rounds);
  for (const [index, entry] of advanced.entries()) {
    const row = rows[index]!;
    if (entry.teamA !== row.team_a || entry.teamB !== row.team_b || entry.winner !== row.winner || entry.status !== row.status) {
      unwrap(await supabase.from('tournament_bracket').update({ team_a: entry.teamA, team_b: entry.teamB, winner: entry.winner, status: entry.status }).eq('id', row.id));
    }
  }

  // Tirage dévoilé 15 min avant : aucun match avant l'heure du début.
  if (Date.now() < new Date(tournament.starts_at).getTime()) return;

  // Rencontres prêtes : match créé (maps tirées au sort, format de la rencontre).
  for (const entry of readyEntries(advanced)) {
    const row = rows.find((r) => r.round === entry.round && r.slot === entry.slot)!;
    const bestOf = double ? bestOfDouble(entry.round, formatOf(tournament)) : bestOfFor(entry.round, rounds, formatOf(tournament), entry.slot);
    const { data, error } = await supabase.rpc('tournament_create_match', { p_entry: row.id, p_maps: pickMaps(config.cod.maps, bestOf), p_mode: config.cod.modes[0], p_best_of: bestOf });
    if (error) {
      console.error('[tournoi] création du match impossible', error.message);
      continue;
    }
    const match = data as { id: string; roster_a: string[]; roster_b: string[]; team_a: string; team_b: string } | null;
    if (!match?.id) continue;
    if (isCup(tournament.kind)) await openMatchVoice(match, tournament.name).catch((caught) => console.warn('[tournoi] salons vocaux impossibles', (caught as Error).message));
    await pushToUsers([...match.roster_a, ...match.roster_b], {
      title: `🏆 ${double ? roundNameDouble(entry.round, tournament.size) : isThirdPlace(entry, rounds) ? 'Petite finale' : roundName(entry.round, rounds)} : à vous de jouer`,
      body: `${tournament.name} · BO${bestOf}. Ouvre la feuille de match.`,
      url: `/cod/equipes/match/${match.id}`,
      tag: `team-match-${match.id}`,
      urgent: true,
    });
  }

  const result = double ? podiumDouble(advanced, tournament.size) : podium(advanced, rounds);
  if (result) await completeTournament(tournament, result.winner, result.finalist, result.third);
}

async function completeTournament(tournament: TournamentRow, winner: string | null, finalist: string | null, third: string | null = null): Promise<void> {
  if (isCup(tournament.kind)) return completeCup(tournament, winner, finalist, third);
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
  const channel = (isCup(kind) && config.discord.divisionChannelId) || config.discord.codChannelId || config.discord.resultsChannelId;
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
  if (tournament.kind === 'anubis') return rewardAnubis(tournament, winner, finalist, third);
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
  if (config.teams.discord)
    void postAnnouncement({
      type: 'horus',
      title: `${tournament.name} : victoire de ${label(winner)}`,
      subtitle: 'Résultats',
      text: `🥇 **${label(winner)}** (+${CUP_BONUS.or} pts)\n🥈 ${label(finalist)} (+${CUP_BONUS.argent} pts)${third ? `\n🥉 ${label(third)} (+${CUP_BONUS.bronze} pts)` : ''}\n\nFélicitations aux vainqueurs ! Le tableau final et les trophées sont en ligne.`,
      url: PAGE,
    });
  const winnerEntry = participants.find((p) => p.team_id === winner);
  if (winnerEntry) await passCupRole('horus', winnerEntry.match_roster ?? winnerEntry.frozen_roster);
}

/** Fin d'une Coupe Anubis : médailles or / argent / bronze pour tous les joueurs des équipes du podium (remplaçants compris), rôle Discord. */
async function rewardAnubis(tournament: TournamentRow, winner: string | null, finalist: string | null, third: string | null): Promise<void> {
  const participants = await participantsOf(tournament.id);
  const teams = (unwrap(await supabase.from('teams').select('id, name, tag').in('id', [winner, finalist, third].filter(Boolean) as string[])) ?? []) as {
    id: string;
    name: string;
    tag: string;
  }[];
  const label = (teamId: string | null) => {
    const team = teams.find((t) => t.id === teamId);
    return team ? `[${team.tag}] ${team.name}` : '—';
  };
  const rosterOf = (teamId: string | null) => participants.find((p) => p.team_id === teamId)?.frozen_roster ?? [];
  const medals = (
    [
      [winner, 'or'],
      [finalist, 'argent'],
      [third, 'bronze'],
    ] as const
  ).flatMap(([teamId, place]) =>
    rosterOf(teamId).map((userId) => ({ user_id: userId, tournament_id: tournament.id, place, name: tournament.name, team_name: teams.find((t) => t.id === teamId)?.name ?? null })),
  );
  if (medals.length) {
    const { error } = await supabase.from('cup_medals').upsert(medals, { onConflict: 'user_id,tournament_id' });
    if (error) console.error('[anubis] médailles impossibles', error.message);
  }
  await pushToUsers(participants.flatMap((p) => p.frozen_roster), {
    title: `𓂀 ${tournament.name} : victoire de ${label(winner)}`,
    body: 'Le tableau final et les médailles sont en ligne.',
    url: `${PAGE}?coupe=anubis`,
    tag: `tournoi-${tournament.id}`,
  });
  const list = async (teamId: string | null) => [...(await playersInfo(rosterOf(teamId))).values()].map((p) => p.username).join(', ');
  await announce(
    `𓂀 **${tournament.name}** terminée !\n🥇 ${label(winner)} : ${await list(winner)}\n🥈 ${label(finalist)} : ${await list(finalist)}${third ? `\n🥉 ${label(third)} : ${await list(third)}` : ''}\n${config.siteUrl}${PAGE}?coupe=anubis`,
    tournament.kind,
  );
  if (config.teams.discord)
    void postAnnouncement({
      type: 'anubis',
      title: `${tournament.name} : victoire de ${label(winner)}`,
      subtitle: 'Résultats',
      text: `🥇 **${label(winner)}** : ${await list(winner)}\n🥈 ${label(finalist)} : ${await list(finalist)}${third ? `\n🥉 ${label(third)} : ${await list(third)}` : ''}\n\nLes médailles sont sur les profils des joueurs.`,
      url: `${PAGE}?coupe=anubis`,
    });
  await passCupRole('anubis', rosterOf(winner));
}

/** Rôle « Vainqueur — Coupe … » : retiré aux vainqueurs précédents, donné aux nouveaux (gardé jusqu'à la coupe suivante du même type). */
async function passCupRole(kind: 'horus' | 'anubis', roster: string[]): Promise<void> {
  if (!discordEnabled || !config.teams.discord) return;
  const { guildId } = config.discord;
  const spec = CUP_ROLES[kind];
  try {
    const roles = (await discord(`/guilds/${guildId}/roles`)) as { id: string; name: string }[];
    const role = roles.find((r) => r.name === spec.name) ?? ((await discord(`/guilds/${guildId}/roles`, { method: 'POST', body: { name: spec.name, color: spec.color, hoist: true } })) as { id: string });
    const state = unwrap(await supabase.from('app_state').select('value').eq('key', spec.key).maybeSingle()) as { value: string } | null;
    const previous = state ? (JSON.parse(state.value) as string[]) : [];
    for (const discordId of (await discordIds(previous.filter((id) => !roster.includes(id)))).values()) {
      await discord(`/guilds/${guildId}/members/${discordId}/roles/${role.id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    for (const discordId of (await discordIds(roster)).values()) {
      await discord(`/guilds/${guildId}/members/${discordId}/roles/${role.id}`, { method: 'PUT' }).catch(() => undefined);
    }
    unwrap(await supabase.from('app_state').upsert({ key: spec.key, value: JSON.stringify(roster) }));
  } catch (caught) {
    console.warn('[coupe] rôle Discord impossible', (caught as Error).message);
  }
}

// --- Coupe Horus : rendez-vous récurrents -------------------------------------------------------

interface ScheduleRow {
  id: string;
  kind: 'horus' | 'anubis';
  team_size: number | null;
  name: string;
  weekday: number;
  start_time: string;
  size: number;
  best_of: number;
  final_best_of: number;
  bracket: BracketType;
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
export function parisInstant(day: string, time: string): Date {
  const guess = new Date(`${day}T${time.slice(0, 5)}:00Z`);
  return new Date(guess.getTime() - parisOffset(guess) * 60_000);
}

/** Prochaine date du rendez-vous (jour de la semaine, heure de Paris), au moins 20 min plus tard (avant le tirage). */
export function nextOccurrence(weekday: number, time: string, now = Date.now()): { day: string; startsAt: Date } {
  for (let k = 0; k <= 7; k += 1) {
    const day = new Date(now + k * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    const startsAt = parisInstant(day, time);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() === weekday && startsAt.getTime() > now + (REVEAL_MINUTES + 5) * 60_000) return { day, startsAt };
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
    await openCup({
      kind: schedule.kind,
      teamSize: schedule.team_size,
      name: schedule.name,
      size: schedule.size,
      bestOf: schedule.best_of,
      finalBestOf: schedule.final_best_of,
      bracket: schedule.bracket,
      startsAt: next.startsAt,
      scheduleId: schedule.id,
      adminId: schedule.created_by,
    });
    unwrap(await supabase.from('cup_schedules').update({ last_date: next.day }).eq('id', schedule.id));
  }
}

async function openCup(input: {
  kind: 'horus' | 'anubis';
  teamSize: number | null;
  name: string;
  size: number;
  bestOf: number;
  finalBestOf: number;
  bracket: BracketType;
  startsAt: Date;
  scheduleId: string | null;
  adminId: string | null;
}) {
  const season = unwrap(await supabase.from('seasons').select('id').eq('is_active', true).maybeSingle()) as { id: number } | null;
  const tournament = unwrap(
    await supabase
      .from('tournaments')
      .insert({
        kind: input.kind,
        team_size: input.kind === 'anubis' ? input.teamSize : null,
        name: input.name,
        size: input.size,
        best_of: input.bestOf,
        final_best_of: input.finalBestOf,
        bracket: input.bracket,
        third_place: input.bracket === 'single',
        starts_at: input.startsAt.toISOString(),
        season_id: season?.id ?? null,
        schedule_id: input.scheduleId,
        created_by: input.adminId,
      })
      .select('*')
      .single(),
  ) as TournamentRow;
  const date = input.startsAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const format = `${input.bracket === 'double' ? 'double élimination' : 'élimination directe'}, BO${input.bestOf} (finale BO${input.finalBestOf}), ${date}. Check-in de 2 h à 15 min avant.`;
  await announce(
    input.kind === 'anubis'
      ? `𓂀 **${input.name}** : inscriptions ouvertes ! Inscris-toi seul, les équipes de ${input.teamSize} sont tirées au sort (${input.size} équipes max), ${format}\n${config.siteUrl}${PAGE}?coupe=anubis`
      : `🏆 **${input.name}** : inscriptions ouvertes ! ${input.size} équipes max, ${format}\n${config.siteUrl}${PAGE}`,
    input.kind,
  );
  if (config.teams.discord)
    void postAnnouncement({
      type: input.kind,
      title: `${input.name} : inscriptions ouvertes`,
      subtitle: date,
      text:
        input.kind === 'anubis'
          ? `Inscris-toi **seul** : les équipes de ${input.teamSize} sont tirées au sort au début de la coupe (${input.size} équipes au plus).\n\n📅 **${date}**\n⚔️ ${format}\n🥇 Médailles or, argent et bronze sur ton profil.`
          : `Inscris ton équipe : ${input.size} places.\n\n📅 **${date}**\n⚔️ ${format}\n🏆 Trophées or, argent et bronze et points de Division.`,
      url: input.kind === 'anubis' ? `${PAGE}?coupe=anubis` : PAGE,
    });
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
  const bracket: BracketType = (body as { bracket?: unknown } | undefined)?.bracket === 'double' ? 'double' : 'single';
  const kind: 'horus' | 'anubis' = (body as { kind?: unknown } | undefined)?.kind === 'anubis' ? 'anubis' : 'horus';
  let teamSize: number | null = null;
  if (kind === 'anubis') {
    teamSize = Number((body as { teamSize?: unknown } | undefined)?.teamSize);
    const sizes: number[] = config.teams.rosterSize === 1 ? [1, ...ANUBIS_TEAM_SIZES] : [...ANUBIS_TEAM_SIZES];
    if (!sizes.includes(teamSize)) throw new HttpError(400, 'INVALID_CUP', 'Taille des équipes : 2, 3 ou 4 joueurs.');
  }
  return { kind, teamSize, name, size, bestOf, finalBestOf, bracket };
}

export async function cupAdmin() {
  const [auto, schedules, cups] = await Promise.all([
    cupsAuto(),
    supabase.from('cup_schedules').select('*').order('created_at'),
    supabase.from('tournaments').select('*').in('kind', ['horus', 'anubis']).order('starts_at', { ascending: false }).limit(12),
  ]);
  return {
    auto,
    // Mode test (TEAM_MATCH_PLAYERS=1) : Coupe Anubis en 1v1 possible.
    testTeamSize: config.teams.rosterSize === 1,
    schedules: ((schedules.data ?? []) as ScheduleRow[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      teamSize: row.team_size,
      name: row.name,
      weekday: row.weekday,
      time: row.start_time.slice(0, 5),
      size: row.size,
      bestOf: row.best_of,
      finalBestOf: row.final_best_of,
      bracket: row.bracket,
      active: row.active,
      next: nextOccurrence(row.weekday, row.start_time).startsAt.toISOString(),
    })),
    cups: ((cups.data ?? []) as TournamentRow[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      teamSize: row.team_size,
      name: row.name,
      size: row.size,
      startsAt: row.starts_at,
      status: row.status,
      bestOf: row.best_of,
      finalBestOf: row.final_best_of,
      bracket: row.bracket,
    })),
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
      kind: input.kind,
      team_size: input.teamSize,
      name: input.name,
      weekday: input.weekday,
      start_time: input.time,
      size: input.size,
      best_of: input.bestOf,
      final_best_of: input.finalBestOf,
      bracket: input.bracket,
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
        .update({
          kind: input.kind,
          team_size: input.teamSize,
          name: input.name,
          weekday: input.weekday,
          start_time: input.time,
          size: input.size,
          best_of: input.bestOf,
          final_best_of: input.finalBestOf,
          bracket: input.bracket,
          last_date: null,
        })
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
  if (startsAt.getTime() < Date.now() + (REVEAL_MINUTES + 5) * 60_000) throw new HttpError(400, 'INVALID_CUP', `La coupe doit commencer dans plus de ${REVEAL_MINUTES + 5} min.`);
  await openCup({ ...input, startsAt, scheduleId: null, adminId });
  return cupAdmin();
}
