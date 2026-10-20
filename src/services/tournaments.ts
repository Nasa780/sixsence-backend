import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { SUPPRESS_EMBEDS, discord, discordEnabled, discordIds, notifyStaff } from './discord.js';
import { pushToUsers } from './push.js';
import { pickMaps } from './teamMatchPolicy.js';
import { membershipOf } from './teams.js';
import {
  CHECKIN_MINUTES,
  QUALIFY_MATCHES,
  TOURNAMENT_SIZES,
  advanceBracket,
  bestOfFor,
  emptyRounds,
  firstRound,
  podium,
  qualifiedTeams,
  readyEntries,
  roundName,
  roundsFor,
  type BracketEntry,
} from './tournamentPolicy.js';

/**
 * Tournoi de fin de saison (mode « Match team », étape 3) : création par un admin (qualifiés et
 * effectifs figés), check-in des Leaders 30 min avant, déroulé automatique en une soirée (matchs
 * créés dès que deux équipes se font face), trophées et rôle Discord du vainqueur.
 * Règles pures dans tournamentPolicy.ts ; tables et fonctions SQL dans la migration 0028.
 */

interface TournamentRow {
  id: string;
  season_id: number | null;
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

const PAGE = '/cod/equipes/tournoi';
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
  if (!config.teams.enabled) throw new HttpError(403, 'TEAM_MODE_PAUSED', 'Le mode Match team est en pause.');
  const { name, startsAt, size } = parseCreate(body);
  const { count, error } = await supabase.from('tournaments').select('id', { count: 'exact', head: true }).in('status', ['scheduled', 'running']);
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
  return rows.map((row) => ({ id: row.id, name: row.name, size: row.size, startsAt: row.starts_at, status: row.status }));
}

// --- Lecture --------------------------------------------------------------------------------

/** Tournoi à afficher : prévu ou en cours, sinon le dernier terminé. */
export async function currentTournament(viewerId: string | null) {
  const active = unwrap(await supabase.from('tournaments').select('id').in('status', ['scheduled', 'running']).order('starts_at').limit(1).maybeSingle()) as { id: string } | null;
  const last = active ?? (unwrap(await supabase.from('tournaments').select('id').eq('status', 'completed').order('completed_at', { ascending: false }).limit(1).maybeSingle()) as { id: string } | null);
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
    if (member && participant) {
      viewer = {
        teamId: member.team_id,
        isLeader: member.role === 'leader' || member.isOwner,
        checkedIn: Boolean(participant.checked_in_at),
        matchRoster: participant.match_roster,
        frozenRoster: await namesOf(participant.frozen_roster),
        rosterSize: config.teams.rosterSize,
        canCheckIn: (member.role === 'leader' || member.isOwner) && tournament.status === 'scheduled' && checkInOpen(tournament),
      };
    }
  }

  return {
    id: tournament.id,
    name: tournament.name,
    size: tournament.size,
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
        bestOf: bestOfFor(round, rounds),
        entries: display
          .filter((entry) => entry.round === round)
          .map((entry) => {
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
          }),
      };
    }),
    viewer,
  };
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

/** Check-in d'un Leader : titulaires choisis parmi l'effectif figé (modifiables jusqu'au début). */
export async function checkIn(userId: string, id: string, body: unknown) {
  const tournament = await tournamentRow(id);
  if (tournament.status !== 'scheduled') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'Le check-in est fermé.');
  if (!checkInOpen(tournament)) throw new HttpError(409, 'CHECKIN_CLOSED', `Le check-in ouvre ${CHECKIN_MINUTES} min avant le début du tournoi.`);
  const member = await membershipOf(userId);
  if (!member || !(member.role === 'leader' || member.isOwner)) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Seul un Leader peut faire le check-in.');
  const participant = (await participantsOf(id)).find((p) => p.team_id === member.team_id);
  if (!participant) throw new HttpError(403, 'NOT_QUALIFIED', 'Ton équipe n’est pas qualifiée pour ce tournoi.');
  const size = config.teams.rosterSize;
  const roster = (body as { roster?: unknown } | undefined)?.roster;
  if (!Array.isArray(roster) || roster.length !== size || new Set(roster).size !== size || !roster.every((rid) => participant.frozen_roster.includes(rid))) {
    throw new HttpError(400, 'INVALID_ROSTER', `Choisis ${size} titulaire${size > 1 ? 's' : ''} parmi l’effectif inscrit au tournoi.`);
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
  } catch (caught) {
    console.error('[tournoi] tâche impossible', (caught as Error).message);
  }
}

/** Début : équipes sans check-in déclarées forfait (retirées du 1er tour), puis 1ers matchs. */
async function startTournament(tournament: TournamentRow): Promise<void> {
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

  // Rencontres prêtes : match créé (maps tirées au sort, finale en BO5).
  for (const entry of readyEntries(advanced)) {
    const row = rows.find((r) => r.round === entry.round && r.slot === entry.slot)!;
    const bestOf = bestOfFor(entry.round, rounds);
    const { data, error } = await supabase.rpc('tournament_create_match', { p_entry: row.id, p_maps: pickMaps(config.cod.maps, bestOf - 1), p_mode: config.cod.modes[0], p_best_of: bestOf });
    if (error) {
      console.error('[tournoi] création du match impossible', error.message);
      continue;
    }
    const match = data as { id: string; roster_a: string[]; roster_b: string[] } | null;
    if (!match?.id) continue;
    await pushToUsers([...match.roster_a, ...match.roster_b], {
      title: `🏆 ${roundName(entry.round, rounds)} : à vous de jouer`,
      body: `${tournament.name} · BO${bestOf}. Ouvre la feuille de match.`,
      url: `/cod/equipes/match/${match.id}`,
      tag: `team-match-${match.id}`,
      urgent: true,
    });
  }

  const result = podium(advanced, rounds);
  if (result) await completeTournament(tournament, result.winner, result.finalist);
}

async function completeTournament(tournament: TournamentRow, winner: string | null, finalist: string | null): Promise<void> {
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

async function announce(content: string): Promise<void> {
  const channel = config.discord.codChannelId || config.discord.resultsChannelId;
  if (!discordEnabled || !config.teams.discord || !channel) return;
  await discord(`/channels/${channel}/messages`, { method: 'POST', body: { content, flags: SUPPRESS_EMBEDS } }).catch((caught) =>
    console.warn('[tournoi] annonce impossible', (caught as Error).message),
  );
}
