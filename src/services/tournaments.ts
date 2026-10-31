import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { postAnnouncement } from './announcements.js';
import { parsePosterUrl, posterOf } from './cupPosters.js';
import { circuitOrder } from './circuit.js';
import { CIRCUIT_POINTS, finalQualified, finalWithPlayIn, playInPairs } from './circuitPolicy.js';
import { mapPool } from './maps.js';
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
  anubisReserve,
  reserveTeams,
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
import { CUP_ALERT_MINUTES, CUP_FORFEIT_ALERT_MINUTES, waitedFor } from './waitPolicy.js';

/**
 * Tournoi de fin de saison (Division, étape 3) : création par un admin (qualifiés et
 * effectifs figés), check-in d'un joueur de l'équipe de 2 h à 15 min avant, déroulé automatique en une soirée (matchs
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
 * joueur 30 min avant, puis équipes formées au hasard à la taille choisie par l'admin (team_size), sans remplaçant
 * (liste d'attente seulement avant le tirage), capitaine = le mieux classé (formTeams). Équipes temporaires (teams.cup_tournament, créées
 * dissoutes : jamais au classement). Même tableau et même déroulé que la Coupe Horus ; récompenses :
 * médailles or / argent / bronze pour les joueurs (cup_medals) et rôle « Vainqueur — Coupe Anubis » ; pas de points.
 *
 * Play-in (kind 'playin', migration 0049) : veille de la grande finale, créé par un admin ; 7e et 8e du circuit
 * contre les 2 meilleures équipes de la Division (playInPairs), 2 rencontres BO3 en un seul tour, même check-in et
 * effectifs figés que le tournoi de saison ; les 2 vainqueurs (winner_team, finalist_team) prennent les dernières
 * places de la grande finale (finalists). Pas de trophée ni de points.
 */

type Kind = 'saison' | 'horus' | 'anubis' | 'playin';
/** Coupes à inscription libre (Horus : équipes, Anubis : joueurs). */
const isCup = (kind: Kind) => kind === 'horus' || kind === 'anubis';
/** Un seul tour pour le play-in (2 rencontres indépendantes). */
const roundsOf = (tournament: Pick<TournamentRow, 'kind' | 'size'>) => (tournament.kind === 'playin' ? 1 : roundsFor(tournament.size));
/** Page d'un tournoi sur le site. */
const pageOf = (kind: Kind) => (kind === 'anubis' ? `${PAGE}?coupe=anubis` : kind === 'saison' ? `${PAGE}?coupe=saison` : kind === 'playin' ? `${PAGE}?coupe=playin` : PAGE);

interface TournamentRow {
  id: string;
  season_id: number | null;
  kind: Kind;
  best_of: number;
  final_best_of: number;
  /** BO du tableau des perdants (double élimination), null = best_of (migration 0058). */
  losers_best_of: number | null;
  third_place: boolean;
  bracket: BracketType;
  third_team: string | null;
  team_size: number | null;
  schedule_id: string | null;
  name: string;
  size: number;
  starts_at: string;
  status: 'scheduled' | 'running' | 'completed' | 'cancelled';
  /** Affiche envoyée par l'admin (migration 0055) ; sinon affiche générée (posterOf). */
  poster_url: string | null;
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
  /** Remplaçant présent mais pas retenu au tirage (migration 0056). */
  bench: boolean;
}

interface CupPlayerRow {
  tournament_id: string;
  user_id: string;
  registered_at: string;
  checked_in_at: string | null;
  team_id: string | null;
}

const PAGE = '/cod/tournoi';
/** Match de tournoi « en retard » : partie pas encore créée par l'hôte (pas de code) 10 min après le match. */
const LATE_MINUTES = 10;
const CUP_ROLES = {
  horus: { name: 'Vainqueur — Coupe Horus', key: 'horus_role_holders', color: 0xd4af37 },
  anubis: { name: 'Vainqueur — Coupe Anubis', key: 'anubis_role_holders', color: 0x7f5af0 },
} as const;
const formatOf = (tournament: TournamentRow) => ({ bestOf: tournament.best_of, finalBestOf: tournament.final_best_of, losersBestOf: tournament.losers_best_of });
const toEntry = (row: EntryRow): BracketEntry => ({ round: row.round, slot: row.slot, teamA: row.team_a, teamB: row.team_b, winner: row.winner, status: row.status });

/** Joueurs par équipe d'un tournoi : choisi par l'admin pour les Coupes Horus et Anubis, sinon format de la Division. */
const playersPerTeam = (tournament: { team_size: number | null }) => tournament.team_size ?? config.teams.rosterSize;

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

/**
 * Qualifiés du tournoi de fin de saison : avec un circuit (au moins une Coupe Horus terminée cette saison), les
 * premières du circuit puis les 2 meilleures de la Division pas encore qualifiées (circuitPolicy) ; sans circuit,
 * le classement de la Division (QUALIFY_MATCHES matchs au moins). Ordre = têtes de série.
 */
async function finalists(size: number) {
  const teams = await rankedTeams();
  const division = qualifiedTeams(teams, teams.length);
  const circuit = await circuitOrder();
  if (circuit.length === 0) return division.slice(0, size).map((team) => ({ ...team, via: 'division' as const }));
  const byId = new Map(teams.map((team) => [team.id, team]));
  const active = new Set(byId.keys());
  // Play-in joué cette saison : places directes du circuit, puis ses 2 vainqueurs ; place encore libre = Division.
  const playIn = await seasonPlayIn('completed');
  const pairs = playIn ? playInPairs(circuit, division, size, active) : null;
  if (playIn && pairs) {
    const qualified: { teamId: string; via: 'circuit' | 'playin' | 'division' }[] = finalWithPlayIn(pairs.direct, [playIn.winner_team, playIn.finalist_team], active);
    const taken = new Set(qualified.map((q) => q.teamId));
    for (const team of division) if (qualified.length < size && !taken.has(team.id)) qualified.push({ teamId: team.id, via: 'division' });
    return qualified.map((q) => ({ ...byId.get(q.teamId)!, via: q.via }));
  }
  return finalQualified(circuit, division, size, active).map((q) => ({ ...byId.get(q.teamId)!, via: q.via }));
}

/** Dernier play-in de la saison active (statut voulu, sinon prévu, en cours ou terminé). */
async function seasonPlayIn(status?: TournamentRow['status']) {
  const season = unwrap(await supabase.from('seasons').select('id').eq('is_active', true).maybeSingle()) as { id: number } | null;
  if (!season) return null;
  let query = supabase.from('tournaments').select('*').eq('kind', 'playin').eq('season_id', season.id);
  query = status ? query.eq('status', status) : query.in('status', ['scheduled', 'running', 'completed']);
  return unwrap(await query.order('created_at', { ascending: false }).limit(1).maybeSingle()) as TournamentRow | null;
}

/**
 * Affiches du play-in (page Circuit, aperçu de l'admin) : celles du play-in de la saison s'il existe (avec les
 * résultats), sinon celles que donnerait le classement actuel pour une grande finale de `size` places.
 */
export async function playInOverview(size = 8) {
  const teams = await rankedTeams();
  const byId = new Map(teams.map((team) => [team.id, team]));
  const card = (id: string | null) => {
    const team = id ? byId.get(id) : undefined;
    return team ? { id: team.id, name: team.name, tag: team.tag, color: team.color, logoUrl: team.logo_url } : null;
  };
  const playIn = await seasonPlayIn();
  if (playIn) {
    const [rows, participants] = await Promise.all([entriesOf(playIn.id), participantsOf(playIn.id)]);
    const via = (id: string | null) => (id && participants.find((p) => p.team_id === id)?.seed) ?? null;
    return {
      id: playIn.id,
      name: playIn.name,
      status: playIn.status,
      startsAt: playIn.starts_at,
      projected: false,
      pairs: rows
        .filter((row) => row.round === 1)
        .sort((a, b) => a.slot - b.slot)
        .map((row) => ({ a: card(row.team_a), b: card(row.team_b), seedA: via(row.team_a), seedB: via(row.team_b), winner: row.winner, status: row.status, matchId: row.match_id })),
    };
  }
  const pairs = playInPairs(await circuitOrder(), qualifiedTeams(teams, teams.length), size, new Set(byId.keys()));
  if (!pairs) return null;
  return {
    id: null,
    name: null,
    status: 'projected',
    startsAt: null,
    projected: true,
    pairs: pairs.pairs.map(([a, b], index) => ({ a: card(a), b: card(b), seedA: size - 1 + index, seedB: null, winner: null, status: 'pending', matchId: null })),
  };
}

/** Crée le play-in de la saison : 2 rencontres BO3 (effectifs figés, check-in comme le tournoi de saison). */
export async function createPlayIn(adminId: string, body: unknown) {
  if (!config.teams.enabled) throw new HttpError(403, 'TEAM_MODE_PAUSED', 'La Division est en pause.');
  const input = (body ?? {}) as { startsAt?: unknown; size?: unknown };
  const size = (TOURNAMENT_SIZES as readonly number[]).includes(Number(input.size)) ? Number(input.size) : 8;
  const startsAt = new Date(typeof input.startsAt === 'string' ? input.startsAt : '');
  if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'INVALID_TOURNAMENT', 'Date de début invalide.');
  if (startsAt.getTime() < Date.now() + (REVEAL_MINUTES + 5) * 60_000) throw new HttpError(400, 'INVALID_TOURNAMENT', `Le play-in doit commencer dans plus de ${REVEAL_MINUTES + 5} min.`);
  if (await seasonPlayIn()) throw new HttpError(409, 'TOURNAMENT_EXISTS', 'Le play-in de la saison est déjà prévu ou joué.');
  const season = unwrap(await supabase.from('seasons').select('id, name').eq('is_active', true).maybeSingle()) as { id: number; name: string | null } | null;
  if (!season) throw new HttpError(409, 'NO_SEASON', 'Aucune saison active.');
  const teams = await rankedTeams();
  const pairs = playInPairs(await circuitOrder(), qualifiedTeams(teams, teams.length), size, new Set(teams.map((team) => team.id)));
  if (!pairs) throw new HttpError(409, 'NOT_ENOUGH_TEAMS', `Pas de play-in possible : il faut ${size} équipes au circuit et 2 équipes de Division (${QUALIFY_MATCHES} matchs) pas encore qualifiées.`);

  const order = pairs.pairs.flat();
  const members = (unwrap(await supabase.from('team_members').select('team_id, user_id').in('team_id', order)) ?? []) as { team_id: string; user_id: string }[];
  const name = `Play-in — ${season.name ?? 'Saison'}`.slice(0, 60);
  const tournament = unwrap(
    await supabase
      .from('tournaments')
      .insert({ name, kind: 'playin', size: 4, best_of: 3, final_best_of: 3, third_place: false, bracket: 'single', starts_at: startsAt.toISOString(), season_id: season.id, created_by: adminId })
      .select('*')
      .single(),
  ) as TournamentRow;
  unwrap(
    await supabase.from('tournament_teams').insert(
      order.map((teamId, index) => ({
        tournament_id: tournament.id,
        team_id: teamId,
        seed: index + 1,
        frozen_roster: members.filter((member) => member.team_id === teamId).map((member) => member.user_id),
      })),
    ),
  );
  unwrap(
    await supabase
      .from('tournament_bracket')
      .insert(pairs.pairs.map(([a, b], slot) => ({ tournament_id: tournament.id, round: 1, slot, team_a: a, team_b: b, status: 'pending' }))),
  );

  const date = startsAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  await pushToUsers(members.map((member) => member.user_id), {
    title: `⚔️ Ton équipe joue le play-in`,
    body: `Une place en grande finale en jeu, BO3 ${date}. Check-in d’un joueur de l’équipe de 2 h à 15 min avant.`,
    url: pageOf('playin'),
    tag: `tournoi-${tournament.id}`,
  });
  await announce(`⚔️ **${name}** — 2 places pour la grande finale, BO3 ${date} (${CHECKIN_TEXT}).\n${config.siteUrl}${pageOf('playin')}`);
  return playInOverview(size);
}

/** Fin du play-in : les vainqueurs des deux rencontres sont qualifiés pour la grande finale. */
async function completePlayIn(tournament: TournamentRow, entries: BracketEntry[]): Promise<void> {
  const winners = [0, 1].map((slot) => entries.find((entry) => entry.slot === slot)?.winner ?? null);
  const claimed = unwrap(
    await supabase
      .from('tournaments')
      .update({ status: 'completed', winner_team: winners[0], finalist_team: winners[1], completed_at: new Date().toISOString() })
      .eq('id', tournament.id)
      .eq('status', 'running')
      .select('id')
      .maybeSingle(),
  );
  if (!claimed) return;
  const participants = await participantsOf(tournament.id);
  const names = (unwrap(await supabase.from('teams').select('id, name, tag').in('id', winners.filter(Boolean) as string[])) ?? []) as { id: string; name: string; tag: string }[];
  const list = names.map((team) => `**[${team.tag}] ${team.name}**`).join(' et ');
  await pushToUsers(participants.flatMap((p) => p.frozen_roster), {
    title: `⚔️ ${tournament.name} terminé`,
    body: list ? `Qualifiées pour la grande finale : ${names.map((team) => team.name).join(' et ')}.` : 'Résultats en ligne.',
    url: pageOf('playin'),
    tag: `tournoi-${tournament.id}`,
  });
  if (list) await announce(`⚔️ **${tournament.name}** : ${list} rejoignent la grande finale !\n${config.siteUrl}${pageOf('playin')}`);
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
    qualified: (await finalists(places)).map((team, index) => ({ seed: index + 1, id: team.id, name: team.name, tag: team.tag, color: team.color, logoUrl: team.logo_url, points: team.points, played: team.played, via: team.via })),
  };
}

/** Crée le tournoi : qualifiés figés (têtes de série, effectifs), tableau du 1er tour. */
export async function createTournament(adminId: string, body: unknown) {
  if (!config.teams.enabled) throw new HttpError(403, 'TEAM_MODE_PAUSED', 'La Division est en pause.');
  const { name, startsAt, size } = parseCreate(body);
  const { count, error } = await supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('kind', 'saison').in('status', ['scheduled', 'running']);
  if (error) throw fromDbError(error);
  if ((count ?? 0) > 0) throw new HttpError(409, 'TOURNAMENT_EXISTS', 'Un tournoi est déjà prévu ou en cours.');

  const qualified = await finalists(size);
  if (qualified.length < 2) throw new HttpError(409, 'NOT_ENOUGH_TEAMS', `Il faut au moins 2 équipes (circuit, ou ${QUALIFY_MATCHES} matchs de Division) pour lancer un tournoi.`);
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
    body: `Début ${date}. Check-in d’un joueur de l’équipe de 2 h à 15 min avant.`,
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
  const rounds = roundsOf(tournament);
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
    ? ((unwrap(await supabase.from('team_matches').select('id, status, scores, winner, best_of, created_at').in('id', matchIds)) ?? []) as {
        id: string;
        status: string;
        scores: [number, number][];
        winner: string | null;
        best_of: number;
        created_at: string;
      }[])
    : [];
  const matchById = new Map(matches.map((match) => [match.id, match]));
  // Code de la partie déjà donné (table privée) : sans lui 10 min après la création, le match est « en retard ».
  const openIds = matches.filter((match) => match.status === 'in_progress').map((match) => match.id);
  const withCode = new Set(
    openIds.length ? (((unwrap(await supabase.from('team_match_codes').select('match_id').in('match_id', openIds)) ?? []) as { match_id: string }[]).map((row) => row.match_id)) : [],
  );
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
        rosterSize: playersPerTeam(tournament),
        canCheckIn: tournament.status === 'scheduled' && checkInOpen(tournament),
        canRegister: false,
        canUnregister: tournament.kind === 'horus' && isLeader && open,
        // Rang de remplaçant (1, 2…) si l'équipe est inscrite au-delà des places, sinon null.
        reserveRank: tournament.kind === 'horus' && participants.indexOf(participant) >= tournament.size ? participants.indexOf(participant) - tournament.size + 1 : null,
      };
    } else if (member && tournament.kind === 'horus') {
      viewer = {
        teamId: member.team_id,
        isLeader,
        registered: false,
        checkedIn: false,
        matchRoster: null,
        frozenRoster: [],
        rosterSize: playersPerTeam(tournament),
        canCheckIn: false,
        canRegister: isLeader && open && participants.length < tournament.size + reserveTeams(tournament.size),
        // L'inscription se fait comme remplaçante (places de la coupe prises).
        asReserve: participants.length >= tournament.size,
        canUnregister: false,
      };
    }
  }

  const present = (entry: BracketEntry) => {
    const row = rows.find((r) => r.round === entry.round && r.slot === entry.slot);
    const match = row?.match_id ? matchById.get(row.match_id) : undefined;
    const mapsA = match ? match.scores.filter(([a, b]) => a > b).length : null;
    // Vainqueur désigné par l'admin après un match annulé : score de forfait (1-0 en BO1, 2-0 en BO3, 3-0 en BO5).
    const decided = Boolean(match && match.status === 'cancelled' && entry.status === 'done' && entry.winner);
    const forfeitMaps = match ? Math.ceil(match.best_of / 2) : 0;
    return {
      id: row?.id ?? null,
      slot: entry.slot,
      teamA: card(entry.teamA),
      teamB: card(entry.teamB),
      winner: entry.winner,
      status: entry.status,
      matchId: row?.match_id ?? null,
      score: decided ? (entry.winner === entry.teamA ? [forfeitMaps, 0] : [0, forfeitMaps]) : match ? [mapsA, match.scores.length - mapsA!] : null,
      decided,
      // Retard : partie pas encore créée par l'hôte 10 min après le match ; litige : contestation ou forfait déclaré.
      late: Boolean(match && match.status === 'in_progress' && match.scores.length === 0 && !withCode.has(match.id) && Date.now() - new Date(match.created_at).getTime() > LATE_MINUTES * 60_000),
      dispute: Boolean(match && (match.status === 'disputed' || match.status === 'forfeit_claimed')),
    };
  };
  const thirdEntry = display.find((entry) => isThirdPlace(entry, rounds));

  // Rendez-vous récurrent : jour, heure et numéro d'édition (coupes du même rendez-vous jusqu'à celle-ci).
  let recurrence: { weekday: number; time: string; edition: number } | null = null;
  if (tournament.schedule_id) {
    const schedule = unwrap(await supabase.from('cup_schedules').select('weekday, start_time').eq('id', tournament.schedule_id).maybeSingle()) as { weekday: number; start_time: string } | null;
    const { count } = await supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('schedule_id', tournament.schedule_id).lte('starts_at', tournament.starts_at);
    if (schedule) recurrence = { weekday: schedule.weekday, time: schedule.start_time.slice(0, 5), edition: count ?? 1 };
  }
  const messages = await tournamentMessages(tournament.id);

  if (tournament.kind === 'anubis') return { ...publicView(), ...(await anubisView(tournament, participants, card, viewerId)) };
  return { ...publicView(), viewer };

  function publicView() {
  return {
    id: tournament.id,
    kind: tournament.kind,
    name: tournament.name,
    posterUrl: posterOf(tournament),
    // Joueurs par équipe (Coupe Anubis : remplacé par anubisView).
    teamSize: playersPerTeam(tournament),
    size: tournament.size,
    bestOf: tournament.best_of,
    finalBestOf: tournament.final_best_of,
    losersBestOf: tournament.bracket === 'double' ? tournament.losers_best_of : null,
    schedule: recurrence,
    messages,
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
    teams: participants.map((p, index) => ({
      ...card(p.team_id)!,
      checkedIn: Boolean(p.checked_in_at),
      forfeit: p.forfeit,
      // Coupe Horus : inscrite au-delà des places (remplaçante tant que le tirage n'est pas fait) ; bench : pas retenue.
      reserve: tournament.kind === 'horus' && tournament.status === 'scheduled' && index >= tournament.size,
      bench: p.bench,
    })),
    reserveSlots: tournament.kind === 'horus' ? reserveTeams(tournament.size) : 0,
    bracket: tournament.bracket,
    minTeams: tournament.kind === 'horus' || tournament.kind === 'anubis' ? CUP_MIN_TEAMS : null,
    // Ce que rapporte chaque place (Coupe Horus) : points de Division et de circuit.
    rewards:
      tournament.kind === 'horus'
        ? {
            division: { winner: CUP_BONUS.or, finalist: CUP_BONUS.argent, third: CUP_BONUS.bronze, present: CUP_BONUS.participation },
            circuit: { winner: CIRCUIT_POINTS.winner, finalist: CIRCUIT_POINTS.finalist, third: CIRCUIT_POINTS.third, present: CIRCUIT_POINTS.present },
            xp: { win: 500, loss: 150 },
          }
        : null,
    rounds: Array.from({ length: rounds }, (_, index) => {
      const round = index + 1;
      const double = tournament.bracket === 'double';
      return {
        round,
        name: double ? roundNameDouble(round, tournament.size) : tournament.kind === 'playin' ? 'Play-in' : roundName(round, rounds),
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

/** Coupe Anubis : joueurs inscrits (liste d'attente comprise), équipes formées (capitaine, joueurs) et droits du visiteur. */
async function anubisView(tournament: TournamentRow, participants: ParticipantRow[], card: (teamId: string | null) => Card, viewerId: string | null) {
  const players = (unwrap(await supabase.from('cup_players').select('*').eq('tournament_id', tournament.id).order('registered_at')) ?? []) as CupPlayerRow[];
  const ids = [...new Set([...players.map((p) => p.user_id), ...participants.flatMap((p) => p.frozen_roster)])];
  const people = await playersInfo(ids);
  const person = (id: string) => people.get(id) ?? { id, username: 'Joueur', avatarUrl: null, points: 0 };
  const teamSize = tournament.team_size ?? config.teams.rosterSize;
  const capacity = anubisCapacity(tournament.size, teamSize);
  const reserve = anubisReserve(tournament.size, teamSize);
  const open = tournament.status === 'scheduled' && Date.now() < new Date(tournament.starts_at).getTime();
  const squads = participants.map((p) => {
    // Anciennes coupes : l'équipe jouée (match_roster) ; les remplaçants d'alors ne sont plus affichés.
    const starters = p.match_roster ?? p.frozen_roster.slice(0, teamSize);
    return {
      team: card(p.team_id),
      captain: p.captain,
      forfeit: p.forfeit,
      starters: starters.map(person),
    };
  });

  let viewer = null;
  if (viewerId) {
    const me = players.find((p) => p.user_id === viewerId);
    const squad = participants.find((p) => p.frozen_roster.includes(viewerId));
    viewer = {
      solo: true,
      registered: Boolean(me),
      checkedIn: Boolean(me?.checked_in_at),
      canRegister: !me && open && players.length < capacity + reserve,
      // Inscription comme remplaçant (places prises) ; rang de remplaçant du joueur inscrit au-delà des places.
      asReserve: players.length >= capacity,
      reserveRank: me && players.indexOf(me) >= capacity ? players.indexOf(me) - capacity + 1 : null,
      canUnregister: Boolean(me) && open,
      canCheckIn: Boolean(me) && !me?.checked_in_at && tournament.status === 'scheduled' && checkInOpen(tournament),
      teamId: squad?.team_id ?? null,
      isCaptain: Boolean(squad && squad.captain === viewerId),
    };
  }
  return {
    teamSize,
    capacity,
    reserveSlots: reserve,
    registered: players.length,
    checkedInCount: players.filter((p) => p.checked_in_at).length,
    players: players.map((p, index) => ({ ...person(p.user_id), checkedIn: Boolean(p.checked_in_at), reserve: index >= capacity })),
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

/** Check-in d'un joueur de l'équipe (Leader ou non) : joueurs du match choisis parmi l'effectif figé (modifiables jusqu'au début). */
export async function checkIn(userId: string, id: string, body: unknown) {
  const tournament = await tournamentRow(id);
  if (tournament.kind === 'anubis') return checkInPlayer(userId, id);
  if (tournament.status !== 'scheduled') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'Le check-in est fermé.');
  if (!checkInOpen(tournament)) throw new HttpError(409, 'CHECKIN_CLOSED', 'Le check-in est ouvert de 2 h à 15 min avant le début du tournoi.');
  const member = await membershipOf(userId);
  if (!member) throw new HttpError(403, 'TEAM_FORBIDDEN', 'Rejoins une équipe inscrite pour faire le check-in.');
  const participant = (await participantsOf(id)).find((p) => p.team_id === member.team_id);
  if (!participant) {
    throw new HttpError(403, 'NOT_QUALIFIED', tournament.kind === 'horus' ? 'Ton équipe n’est pas inscrite à cette coupe.' : 'Ton équipe n’est pas qualifiée pour ce tournoi.');
  }
  // Coupe Horus : l'effectif est figé au check-in (celui du moment).
  if (tournament.kind === 'horus') {
    participant.frozen_roster = await teamMemberIds(member.team_id);
    unwrap(await supabase.from('tournament_teams').update({ frozen_roster: participant.frozen_roster }).eq('tournament_id', id).eq('team_id', member.team_id));
  }
  const size = playersPerTeam(tournament);
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
  const reserve = reserveTeams(tournament.size);
  if (participants.length >= tournament.size + reserve) throw new HttpError(409, 'CUP_FULL', 'La coupe est complète, places de remplaçant comprises.');
  const roster = await teamMemberIds(member.team_id);
  const needed = playersPerTeam(tournament);
  if (roster.length < needed) {
    throw new HttpError(409, 'TEAM_TOO_SMALL', `Il faut au moins ${needed} joueur${needed > 1 ? 's' : ''} dans l’équipe pour s’inscrire.`);
  }
  // Ordre d'inscription (seed) : après le dernier inscrit, même si une équipe s'est désinscrite entre-temps (remplaçants).
  const nextSeed = participants.reduce((max, p) => Math.max(max, p.seed ?? 0), 0) + 1;
  unwrap(await supabase.from('tournament_teams').insert({ tournament_id: id, team_id: member.team_id, seed: nextSeed, frozen_roster: roster }));
  const left = tournament.size - participants.length - 1;
  if (left === 1 || left === 0) {
    const text = left === 0 ? `complète ! Encore ${reserve} place${reserve > 1 ? 's' : ''} de remplaçant si une équipe manque le check-in.` : 'plus qu’une place !';
    await announce(`🏆 **${tournament.name}** : ${text}\n${config.siteUrl}${PAGE}`, tournament.kind);
  }
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
  const reserve = anubisReserve(tournament.size, tournament.team_size ?? config.teams.rosterSize);
  if ((count ?? 0) >= capacity + reserve) throw new HttpError(409, 'CUP_FULL', 'La coupe est complète, liste d’attente comprise.');
  const { error: insertError } = await supabase.from('cup_players').insert({ tournament_id: tournament.id, user_id: userId });
  if (insertError && insertError.code !== '23505') throw fromDbError(insertError);
  const left = capacity - (count ?? 0) - 1;
  if (left === 1 || left === 0) {
    const text = left === 0 ? `complète ! Encore ${reserve} place${reserve > 1 ? 's' : ''} en liste d’attente si des joueurs manquent le check-in.` : 'plus qu’une place !';
    await announce(`𓂀 **${tournament.name}** : ${text}\n${config.siteUrl}${PAGE}?coupe=anubis`, tournament.kind);
  }
  return getTournament(tournament.id, userId);
}

/** Check-in d'un joueur inscrit (de 2 h à 15 min avant le début). */
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
    await alertCupDelays();
    await ensureScheduledCups();
  } catch (caught) {
    console.error('[tournoi] tâche impossible', (caught as Error).message);
  }
}

/**
 * Alerte rapide du staff pour les coupes en cours (un litige bloque tout le tableau) : contestation sans décision
 * depuis 5 min, forfait sans réponse depuis 20 min. Une alerte par match et par étape (app_claim), en plus de la
 * relance générale ; une rencontre bloquée (match annulé) est déjà signalée tout de suite par advanceTournament.
 */
async function alertCupDelays(now = Date.now()): Promise<void> {
  const running = (unwrap(await supabase.from('tournaments').select('id, name').eq('status', 'running')) ?? []) as { id: string; name: string }[];
  if (running.length === 0) return;
  const names = new Map(running.map((row) => [row.id, row.name]));
  const matches = (unwrap(
    await supabase.from('team_matches').select('id, tournament_id, status, updated_at, forfeit_claimed_at').in('tournament_id', [...names.keys()]).in('status', ['disputed', 'forfeit_claimed']),
  ) ?? []) as { id: string; tournament_id: string; status: string; updated_at: string; forfeit_claimed_at: string | null }[];
  for (const match of matches) {
    const disputed = match.status === 'disputed';
    const since = disputed ? match.updated_at : match.forfeit_claimed_at;
    if (!since || now - Date.parse(since) < (disputed ? CUP_ALERT_MINUTES : CUP_FORFEIT_ALERT_MINUTES) * 60_000) continue;
    const { data: claimed } = await supabase.rpc('app_claim', { p_key: `cup_alert_${match.id}`, p_value: `${match.status}-${since}` });
    if (!claimed) continue;
    await notifyStaff(
      `🚨 **${names.get(match.tournament_id)}** : ${disputed ? 'contestation' : 'forfait sans réponse'} en attente depuis ${waitedFor(now - Date.parse(since))}, le tableau est bloqué.\n${config.siteUrl}/cod/equipes/match/${match.id}`,
    );
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
    const url = pageOf(tournament.kind);
    // Joueurs à prévenir : Anubis, chaque inscrit ; équipes, tout l'effectif (n'importe lequel peut faire le check-in).
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
      ? `Le check-in de ${tournament.name} est ouvert jusqu’à ${closes}. ${tournament.kind === 'anubis' ? 'Confirme ta présence' : 'Un joueur de l’équipe confirme sa présence et choisit les joueurs du match'} : sans check-in, pas de place.`
      : `Dernier rappel : le check-in de ${tournament.name} ferme à ${closes}. ${tournament.kind === 'anubis' ? 'Confirme ta présence' : 'Un joueur de l’équipe doit faire le check-in'} pour jouer.`;
    await pushToUsers(targets, { title: first ? '✅ Check-in ouvert' : '⏰ Check-in : plus que quelques minutes', body: text, url, tag: `checkin-${tournament.id}`, urgent: !first });
    if (discordEnabled && config.teams.discord) await dm(targets, `${first ? '✅' : '⏰'} ${text}\n${config.siteUrl}${url}`);
    if (first) await announce(`✅ **${tournament.name}** : check-in ouvert jusqu’à ${closes}, tirage à ${closes} et premiers matchs à ${hourOf(tournament)}.\n${config.siteUrl}${url}`, tournament.kind);
  }
}

/** Tirage effectué (Coupe Horus, tournoi de saison) : push et message privé aux joueurs engagés. Anubis : déjà prévenus par équipe. */
async function notifyDraw(tournament: TournamentRow, userIds: string[], url: string): Promise<void> {
  const players = [...new Set(userIds)];
  if (players.length === 0) return;
  const text = `Tirage effectué : ton tableau est en ligne, premiers matchs à ${hourOf(tournament)}. Rejoins ton équipe.`;
  await pushToUsers(players, { title: `🏆 ${tournament.name}`, body: text, url, tag: `tournoi-${tournament.id}`, urgent: true });
  if (discordEnabled && config.teams.discord) await dm(players, `🏆 **${tournament.name}** — ${text}\n${config.siteUrl}${url}`);
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
  await notifyDraw(tournament, participants.filter((p) => p.checked_in_at).flatMap((p) => p.match_roster ?? p.frozen_roster), pageOf(tournament.kind));
  await announce(`🏆 **${tournament.name}** : check-in terminé${absent.length ? `, ${absent.length} équipe(s) forfait` : ''}. Premiers matchs à ${hourOf(tournament)} !\n${config.siteUrl}${pageOf(tournament.kind)}`);
  await advanceTournament(tournament.id);
}

/**
 * Début d'une Coupe Horus : équipes sans check-in retirées ; moins de 4 présentes = coupe annulée ;
 * sinon tableau tiré au sort, à la taille juste (4, 8 ou 16), avec petite finale.
 */
async function startCup(tournament: TournamentRow): Promise<void> {
  const participants = await participantsOf(tournament.id);
  // Présentes dans l'ordre d'inscription (seed) : une titulaire absente laisse sa place à la première remplaçante présente.
  const checked = participants.filter((p) => p.checked_in_at);
  const present = checked.slice(0, tournament.size);
  const benched = checked.slice(tournament.size);
  const promoted = present.filter((p) => participants.indexOf(p) >= tournament.size).length;
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
  if (benched.length) {
    unwrap(await supabase.from('tournament_teams').update({ bench: true }).eq('tournament_id', tournament.id).in('team_id', benched.map((p) => p.team_id)));
    await pushToUsers(benched.flatMap((p) => p.match_roster ?? p.frozen_roster), {
      title: `🏆 ${tournament.name}`,
      body: 'Toutes les équipes titulaires sont présentes : ton équipe reste remplaçante pour cette coupe. Merci d’avoir été là !',
      url: PAGE,
      tag: `tournoi-${tournament.id}`,
    });
  }
  const drawn = shuffle(present.map((p) => p.team_id));
  for (const [index, teamId] of drawn.entries()) {
    unwrap(await supabase.from('tournament_teams').update({ seed: index + 1 }).eq('tournament_id', tournament.id).eq('team_id', teamId));
  }
  await drawBracket(tournament, drawn, size);
  await notifyDraw(tournament, present.flatMap((p) => p.match_roster ?? p.frozen_roster), PAGE);
  const replaced = promoted ? ` (${promoted} remplaçante${promoted > 1 ? 's' : ''} entrée${promoted > 1 ? 's' : ''} dans le tableau)` : '';
  await announce(`🏆 **${tournament.name}** : ${present.length} équipes${replaced}, tableau tiré au sort ! Premiers matchs à ${hourOf(tournament)}.\n${config.siteUrl}${PAGE}`, tournament.kind);
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
 * Début d'une Coupe Anubis : équipes formées au hasard parmi les joueurs présents au check-in (capitaine, sans
 * remplaçant), équipes temporaires créées, tableau tiré au sort. Moins de 4 équipes complètes : annulée.
 */
async function startAnubis(tournament: TournamentRow): Promise<void> {
  const players = (unwrap(await supabase.from('cup_players').select('*').eq('tournament_id', tournament.id).order('registered_at')) ?? []) as CupPlayerRow[];
  const teamSize = tournament.team_size ?? config.teams.rosterSize;
  // Présents dans l'ordre d'inscription : un absent laisse sa place au premier inscrit présent de la liste d'attente ;
  // au-delà, pas de place. Une fois les équipes tirées, plus aucun changement.
  const checked = players.filter((p) => p.checked_in_at);
  const present = checked.slice(0, anubisCapacity(tournament.size, teamSize));
  const overflow = checked.slice(present.length).map((p) => p.user_id);
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
        frozen_roster: squad.starters,
        match_roster: squad.starters,
        checked_in_at: now,
        captain: squad.captain,
      }),
    );
    unwrap(await supabase.from('cup_players').update({ team_id: team.id }).eq('tournament_id', tournament.id).in('user_id', squad.starters));
    await pushToUsers(squad.starters, {
      title: `𓂀 ${tournament.name} : tu joues avec ${base.name} [${base.tag}]`,
      body: `Capitaine : ${info.get(squad.captain)?.username ?? 'tiré au sort'}. Rejoins ton équipe : premiers matchs à ${hourOf(tournament)}.`,
      url: `${PAGE}?coupe=anubis`,
      tag: `tournoi-${tournament.id}`,
      urgent: true,
    });
  }
  await drawBracket(tournament, teamIds, size);
  // Présents restés sans place (liste d'attente, ou joueurs en trop pour une équipe complète) : prévenus.
  const placedIds = new Set(formed.flatMap((squad) => squad.starters));
  const unplaced = [...present.map((p) => p.user_id).filter((id) => !placedIds.has(id)), ...overflow];
  if (unplaced.length) {
    await pushToUsers(unplaced, {
      title: `𓂀 ${tournament.name}`,
      body: 'Pas de place pour toi dans les équipes de cette coupe : les joueurs inscrits avant toi sont présents. Merci d’avoir été là !',
      url: `${PAGE}?coupe=anubis`,
      tag: `tournoi-${tournament.id}`,
    });
  }
  const benched = unplaced.length;
  await announce(
    `𓂀 **${tournament.name}** : ${formed.length} équipes de ${teamSize} tirées au sort parmi ${present.length + overflow.length} joueurs${benched > 0 ? ` (${benched} sans place)` : ''} ! Premiers matchs à ${hourOf(tournament)}.\n${config.siteUrl}${PAGE}?coupe=anubis`,
    tournament.kind,
  );
  await advanceTournament(tournament.id);
}

/** Avance le tableau : résultats des matchs reportés, rencontres suivantes créées, fin du tournoi. */
export async function advanceTournament(id: string): Promise<void> {
  const tournament = await tournamentRow(id);
  if (tournament.status !== 'running') return;
  const rounds = roundsOf(tournament);
  const rows = await entriesOf(id);
  // État enregistré, avant les résultats ci-dessous : sert à savoir quelles rencontres réécrire en base.
  const saved = rows.map((row) => ({ ...row }));

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
    const row = saved[index]!;
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
    const { data, error } = await supabase.rpc('tournament_create_match', { p_entry: row.id, p_maps: pickMaps(await mapPool('tournoi'), bestOf), p_mode: config.cod.modes[0], p_best_of: bestOf });
    if (error) {
      console.error('[tournoi] création du match impossible', error.message);
      continue;
    }
    const match = data as { id: string; roster_a: string[]; roster_b: string[]; team_a: string; team_b: string } | null;
    if (!match?.id) continue;
    if (isCup(tournament.kind)) await openMatchVoice(match, tournament.name).catch((caught) => console.warn('[tournoi] salons vocaux impossibles', (caught as Error).message));
    await pushToUsers([...match.roster_a, ...match.roster_b], {
      title: `🏆 ${double ? roundNameDouble(entry.round, tournament.size) : tournament.kind === 'playin' ? 'Play-in' : isThirdPlace(entry, rounds) ? 'Petite finale' : roundName(entry.round, rounds)} : à vous de jouer`,
      body: `${tournament.name} · BO${bestOf}. Ouvre la feuille de match.`,
      url: `/cod/equipes/match/${match.id}`,
      tag: `team-match-${match.id}`,
      urgent: true,
    });
  }

  if (tournament.kind === 'playin') {
    if (advanced.every((entry) => entry.status === 'done' || entry.status === 'empty')) await completePlayIn(tournament, advanced);
    return;
  }
  const result = double ? podiumDouble(advanced, tournament.size) : podium(advanced, rounds);
  if (result) await completeTournament(tournament, result.winner, result.finalist, result.third);
}

type CorrectedMatch = { id: string; tournament_id: string | null; team_a: string; team_b: string; winner: 'A' | 'B' | null; created_at: string };

/**
 * Correction d'un match de tournoi : jamais d'annulation (le tableau en dépend) ; le vainqueur ne change que si le
 * tournoi est en cours et qu'aucune des deux équipes n'a encore joué de rencontre suivante. Les scores, toujours.
 */
export async function assertTournamentCorrectable(match: CorrectedMatch, winner: 'A' | 'B' | null): Promise<void> {
  if (!match.tournament_id) return;
  if (winner === null) throw new HttpError(409, 'TOURNAMENT_MATCH', 'Un match de tournoi ne s’annule pas : corrige les scores (le vainqueur peut changer).');
  if (winner === match.winner) return;
  const tournament = await tournamentRow(match.tournament_id);
  if (tournament.status !== 'running') throw new HttpError(409, 'TOURNAMENT_DONE', 'Le tournoi est terminé : seuls les scores peuvent encore être corrigés, pas le vainqueur.');
  const { count, error } = await supabase
    .from('team_matches')
    .select('id', { count: 'exact', head: true })
    .eq('tournament_id', match.tournament_id)
    .neq('id', match.id)
    .neq('status', 'cancelled')
    .gt('created_at', match.created_at)
    .or(`team_a.in.(${match.team_a},${match.team_b}),team_b.in.(${match.team_a},${match.team_b})`);
  if (error) throw fromDbError(error);
  if ((count ?? 0) > 0) throw new HttpError(409, 'BRACKET_MOVED', 'Une des deux équipes a déjà joué la rencontre suivante : le vainqueur ne peut plus changer.');
}

/** Après la correction d'un match de tournoi : nouveau vainqueur reporté, rencontres suivantes pas encore jouées refaites. */
export async function applyTournamentCorrection(match: CorrectedMatch, winner: 'A' | 'B'): Promise<void> {
  if (!match.tournament_id || winner === match.winner) return;
  const pair = [match.team_a, match.team_b];
  unwrap(await supabase.from('tournament_bracket').update({ winner: winner === 'A' ? match.team_a : match.team_b, status: 'done' }).eq('match_id', match.id));
  // Les deux équipes sont retirées des rencontres sans match (à venir, ou qualification d'office) : le tableau les replace.
  for (const row of await entriesOf(match.tournament_id)) {
    if (row.match_id || !(pair.includes(row.team_a ?? '') || pair.includes(row.team_b ?? ''))) continue;
    unwrap(
      await supabase
        .from('tournament_bracket')
        .update({ team_a: pair.includes(row.team_a ?? '') ? null : row.team_a, team_b: pair.includes(row.team_b ?? '') ? null : row.team_b, winner: null, status: 'pending' })
        .eq('id', row.id),
    );
  }
  await advanceTournament(match.tournament_id);
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

/**
 * Message de tournoi (inscriptions, check-in, tirage, annulation, résultats) : salon des annonces COD, sinon des annonces,
 * sinon salon Division (coupes) ou COD. Sans mention. `illustrated` : une annonce illustrée (postAnnouncement) couvre
 * déjà ce moment dans le salon des annonces, le message texte n'est alors pas publié (pas de doublon).
 */
async function announce(content: string, kind: Kind = 'saison', illustrated = false): Promise<void> {
  const { announceChannelId, codAnnounceChannelId, divisionChannelId, codChannelId, resultsChannelId } = config.discord;
  if (illustrated && (codAnnounceChannelId || announceChannelId)) return;
  const channel = codAnnounceChannelId || announceChannelId || (isCup(kind) && divisionChannelId) || codChannelId || resultsChannelId;
  if (!discordEnabled || !config.teams.discord || !channel) return;
  await discord(`/channels/${channel}/messages`, { method: 'POST', body: { content, flags: SUPPRESS_EMBEDS } }).catch((caught) =>
    console.warn('[tournoi] annonce impossible', (caught as Error).message),
  );
}

// --- Coupe Horus : fin, récompenses ------------------------------------------------------------

/**
 * Fin d'une Coupe Horus : trophées or / argent / bronze (fiche d'équipe, et profil des joueurs de l'équipe : cup_medals
 * kind horus), points de Division, rôle Discord, annonces.
 */
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
  // Trophée aussi sur le profil des joueurs de l'équipe (joueurs du check-in, sinon effectif inscrit).
  const podiumNames = new Map(
    ((unwrap(await supabase.from('teams').select('id, name').in('id', [winner, finalist, third].filter(Boolean) as string[])) ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );
  const playerTrophies = podiumPlaces.flatMap(([teamId, place]) => {
    const entry = participants.find((p) => p.team_id === teamId);
    return (entry?.match_roster ?? entry?.frozen_roster ?? []).map((userId) => ({
      user_id: userId,
      tournament_id: tournament.id,
      place,
      name: tournament.name,
      team_name: podiumNames.get(teamId ?? '') ?? null,
      kind: 'horus',
    }));
  });
  if (playerTrophies.length) {
    const { error } = await supabase.from('cup_medals').upsert(playerTrophies, { onConflict: 'user_id,tournament_id' });
    if (error) console.error('[coupe] trophées des joueurs impossibles', error.message);
  }
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
    true,
  );
  if (config.teams.discord)
    void postAnnouncement({
      type: 'horus',
      title: `${tournament.name} : victoire de ${label(winner)}`,
      subtitle: 'Résultats',
      text: `🥇 **${label(winner)}** (+${CUP_BONUS.or} pts)\n🥈 ${label(finalist)} (+${CUP_BONUS.argent} pts)${third ? `\n🥉 ${label(third)} (+${CUP_BONUS.bronze} pts)` : ''}\n\nFélicitations aux vainqueurs ! Le tableau final et les trophées sont en ligne.`,
      url: `${PAGE}?id=${tournament.id}`,
      image: posterOf(tournament),
    });
  const winnerEntry = participants.find((p) => p.team_id === winner);
  if (winnerEntry) await passCupRole('horus', winnerEntry.match_roster ?? winnerEntry.frozen_roster);
}

/** Fin d'une Coupe Anubis : médailles or / argent / bronze pour tous les joueurs des équipes du podium, rôle Discord. */
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
    true,
  );
  if (config.teams.discord)
    void postAnnouncement({
      type: 'anubis',
      title: `${tournament.name} : victoire de ${label(winner)}`,
      subtitle: 'Résultats',
      text: `🥇 **${label(winner)}** : ${await list(winner)}\n🥈 ${label(finalist)} : ${await list(finalist)}${third ? `\n🥉 ${label(third)} : ${await list(third)}` : ''}\n\nLes médailles sont sur les profils des joueurs.`,
      url: `${PAGE}?id=${tournament.id}`,
      image: posterOf(tournament),
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
  losers_best_of: number | null;
  bracket: BracketType;
  active: boolean;
  last_date: string | null;
  created_by: string | null;
  poster_url: string | null;
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
      losersBestOf: schedule.losers_best_of,
      bracket: schedule.bracket,
      startsAt: next.startsAt,
      scheduleId: schedule.id,
      adminId: schedule.created_by,
      posterUrl: schedule.poster_url,
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
  losersBestOf: number | null;
  bracket: BracketType;
  startsAt: Date;
  scheduleId: string | null;
  adminId: string | null;
  posterUrl: string | null;
}) {
  const season = unwrap(await supabase.from('seasons').select('id').eq('is_active', true).maybeSingle()) as { id: number } | null;
  const tournament = unwrap(
    await supabase
      .from('tournaments')
      .insert({
        kind: input.kind,
        team_size: input.teamSize,
        name: input.name,
        size: input.size,
        best_of: input.bestOf,
        final_best_of: input.finalBestOf,
        losers_best_of: input.losersBestOf,
        bracket: input.bracket,
        third_place: input.bracket === 'single',
        starts_at: input.startsAt.toISOString(),
        season_id: season?.id ?? null,
        schedule_id: input.scheduleId,
        created_by: input.adminId,
        poster_url: input.posterUrl,
      })
      .select('*')
      .single(),
  ) as TournamentRow;
  const date = input.startsAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const format = `${input.bracket === 'double' ? 'double élimination' : 'élimination directe'}, BO${input.bestOf}${input.losersBestOf && input.losersBestOf !== input.bestOf ? ` (perdants BO${input.losersBestOf})` : ''} (finale BO${input.finalBestOf}), ${date}. Check-in de 2 h à 15 min avant.`;
  await announce(
    input.kind === 'anubis'
      ? `𓂀 **${input.name}** : inscriptions ouvertes ! Inscris-toi seul, les équipes de ${input.teamSize} sont tirées au sort (${input.size} équipes max), ${format}\n${config.siteUrl}${PAGE}?coupe=anubis`
      : `🏆 **${input.name}** : inscriptions ouvertes ! ${input.size} équipes max, ${format}\n${config.siteUrl}${PAGE}`,
    input.kind,
    true,
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
      url: `${PAGE}?id=${tournament.id}`,
      image: posterOf(tournament),
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
  // Joueurs par équipe (2 à 5 ; 1 en mode test) : obligatoire pour l'Anubis, format de la Division par défaut pour l'Horus.
  const rawSize = (body as { teamSize?: unknown } | undefined)?.teamSize;
  let teamSize: number | null = null;
  if (kind === 'anubis' || (rawSize !== undefined && rawSize !== null)) {
    teamSize = Number(rawSize);
    const sizes: number[] = config.teams.rosterSize === 1 ? [1, ...ANUBIS_TEAM_SIZES] : [...ANUBIS_TEAM_SIZES];
    if (!sizes.includes(teamSize)) throw new HttpError(400, 'INVALID_CUP', 'Taille des équipes : 2 à 5 joueurs.');
  }
  const posterUrl = parsePosterUrl((body as { posterUrl?: unknown } | undefined)?.posterUrl);
  // Double élimination : BO du tableau des perdants (1 ou 3), sinon même BO que les autres matchs.
  const rawLosers = Number((body as { losersBestOf?: unknown } | undefined)?.losersBestOf);
  const losersBestOf = bracket === 'double' && (rawLosers === 1 || rawLosers === 3) ? rawLosers : null;
  return { kind, teamSize, name, size, bestOf, finalBestOf, losersBestOf, bracket, posterUrl };
}

export async function cupAdmin() {
  const [auto, schedules, open, done] = await Promise.all([
    cupsAuto(),
    supabase.from('cup_schedules').select('*').order('created_at'),
    supabase.from('tournaments').select('*').in('kind', ['horus', 'anubis']).in('status', ['scheduled', 'running']).order('starts_at'),
    supabase.from('tournaments').select('*').in('kind', ['horus', 'anubis']).in('status', ['completed', 'cancelled']).order('starts_at', { ascending: false }).limit(15),
  ]);
  const cupRows = [...((open.data ?? []) as TournamentRow[]), ...((done.data ?? []) as TournamentRow[])];
  const ids = cupRows.map((row) => row.id);
  const [teamRows, playerRows] = ids.length
    ? await Promise.all([
        supabase.from('tournament_teams').select('tournament_id, checked_in_at').in('tournament_id', ids),
        supabase.from('cup_players').select('tournament_id, checked_in_at').in('tournament_id', ids),
      ])
    : [{ data: [] }, { data: [] }];
  const entriesOfCup = (row: TournamentRow) =>
    ((row.kind === 'anubis' ? playerRows.data : teamRows.data) ?? ([] as { tournament_id: string; checked_in_at: string | null }[])).filter(
      (entry: { tournament_id: string }) => entry.tournament_id === row.id,
    ) as { tournament_id: string; checked_in_at: string | null }[];
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
      losersBestOf: row.losers_best_of,
      bracket: row.bracket,
      active: row.active,
      next: nextOccurrence(row.weekday, row.start_time).startsAt.toISOString(),
      posterUrl: row.poster_url,
      poster: posterOf({ ...row, starts_at: nextOccurrence(row.weekday, row.start_time).startsAt.toISOString() }),
    })),
    cups: cupRows.map((row) => {
      const entries = entriesOfCup(row);
      return {
        id: row.id,
        kind: row.kind,
        teamSize: row.team_size,
        name: row.name,
        size: row.size,
        startsAt: row.starts_at,
        checkInOpensAt: new Date(new Date(row.starts_at).getTime() - CHECKIN_MINUTES * 60_000).toISOString(),
        status: row.status,
        bestOf: row.best_of,
        finalBestOf: row.final_best_of,
        losersBestOf: row.losers_best_of,
        bracket: row.bracket,
        scheduleId: row.schedule_id,
        // Coupe Anubis : joueurs ; sinon équipes.
        registered: entries.length,
        checkedIn: entries.filter((entry) => entry.checked_in_at).length,
        capacity: row.kind === 'anubis' ? anubisCapacity(row.size, row.team_size ?? config.teams.rosterSize) : row.size,
        // Places de remplaçant en plus (inscrits au-delà de capacity).
        reserveSlots: row.kind === 'anubis' ? anubisReserve(row.size, row.team_size ?? config.teams.rosterSize) : reserveTeams(row.size),
        posterUrl: row.poster_url,
        poster: posterOf(row),
      };
    }),
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
      losers_best_of: input.losersBestOf,
      bracket: input.bracket,
      poster_url: input.posterUrl,
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
          losers_best_of: input.losersBestOf,
          bracket: input.bracket,
          poster_url: input.posterUrl,
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

/**
 * Modifier une coupe prévue (admin) : nom et affiche jusqu'au début ; date, places et format seulement avant l'ouverture
 * du check-in (2 h avant). Les places ne descendent pas sous le nombre d'inscrits.
 */
export async function updateCup(id: string, body: unknown) {
  const row = await tournamentRow(id);
  if (row.kind !== 'horus' && row.kind !== 'anubis') throw new HttpError(400, 'INVALID_CUP', 'Seules les Coupes Horus et Anubis se modifient ici.');
  if (row.status !== 'scheduled') throw new HttpError(409, 'CUP_STARTED', 'La coupe a déjà commencé : elle ne se modifie plus.');
  const input = parseCupInput({ ...(body as object), kind: row.kind });
  const raw = (body as { startsAt?: unknown } | undefined)?.startsAt;
  const startsAt = typeof raw === 'string' ? new Date(raw) : new Date(row.starts_at);
  if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'INVALID_CUP', 'Date de début invalide.');

  const checkInOpen = Date.now() >= new Date(row.starts_at).getTime() - CHECKIN_MINUTES * 60_000;
  const formatChanged =
    startsAt.getTime() !== new Date(row.starts_at).getTime() ||
    input.size !== row.size ||
    input.bestOf !== row.best_of ||
    input.finalBestOf !== row.final_best_of ||
    input.losersBestOf !== row.losers_best_of ||
    input.bracket !== row.bracket ||
    input.teamSize !== row.team_size;
  if (checkInOpen && formatChanged) throw new HttpError(409, 'CHECKIN_OPEN', 'Le check-in est ouvert : seuls le nom et l’affiche se modifient encore.');
  if (formatChanged && startsAt.getTime() < Date.now() + (REVEAL_MINUTES + 5) * 60_000) {
    throw new HttpError(400, 'INVALID_CUP', `La coupe doit commencer dans plus de ${REVEAL_MINUTES + 5} min.`);
  }
  const registered =
    row.kind === 'anubis'
      ? ((await supabase.from('cup_players').select('user_id', { count: 'exact', head: true }).eq('tournament_id', id)).count ?? 0)
      : ((await supabase.from('tournament_teams').select('team_id', { count: 'exact', head: true }).eq('tournament_id', id)).count ?? 0);
  const capacity = row.kind === 'anubis' ? anubisCapacity(input.size, input.teamSize ?? config.teams.rosterSize) : input.size;
  if (registered > capacity) throw new HttpError(409, 'CUP_TOO_SMALL', `${registered} ${row.kind === 'anubis' ? 'joueurs' : 'équipes'} déjà inscrits : choisis plus de places.`);

  unwrap(
    await supabase
      .from('tournaments')
      .update({
        name: input.name,
        poster_url: input.posterUrl,
        starts_at: startsAt.toISOString(),
        size: input.size,
        best_of: input.bestOf,
        final_best_of: input.finalBestOf,
        losers_best_of: input.losersBestOf,
        bracket: input.bracket,
        third_place: input.bracket === 'single',
        team_size: input.teamSize,
      })
      .eq('id', id),
  );
  return cupAdmin();
}

// --- Messages de l'organisation (fiche d'une coupe) -------------------------------------------

/** Derniers messages de l'équipe SixSence sur un tournoi (les plus récents d'abord), avec l'auteur. */
async function tournamentMessages(tournamentId: string) {
  const rows = (unwrap(await supabase.from('tournament_messages').select('id, author_id, body, created_at').eq('tournament_id', tournamentId).order('created_at', { ascending: false }).limit(10)) ?? []) as {
    id: number;
    author_id: string | null;
    body: string;
    created_at: string;
  }[];
  const authors = await playersInfo([...new Set(rows.map((row) => row.author_id).filter(Boolean) as string[])]);
  return rows.map((row) => ({ id: row.id, body: row.body, createdAt: row.created_at, author: row.author_id ? authors.get(row.author_id)?.username ?? 'Équipe SixSence' : 'Équipe SixSence' }));
}

/** Publier un message de l'organisation sur un tournoi (admin) : 1 000 caractères au plus. */
export async function addTournamentMessage(adminId: string, id: string, body: unknown) {
  await tournamentRow(id);
  const text = typeof (body as { body?: unknown } | undefined)?.body === 'string' ? (body as { body: string }).body.trim() : '';
  if (!text || text.length > 1000) throw new HttpError(400, 'INVALID_MESSAGE', 'Le message fait entre 1 et 1 000 caractères.');
  unwrap(await supabase.from('tournament_messages').insert({ tournament_id: id, author_id: adminId, body: text }));
  return { messages: await tournamentMessages(id) };
}

/** Retirer un message de l'organisation (admin). */
export async function deleteTournamentMessage(id: string, messageId: number) {
  unwrap(await supabase.from('tournament_messages').delete().eq('tournament_id', id).eq('id', messageId));
  return { messages: await tournamentMessages(id) };
}

/** Affiche d'une coupe déjà créée (ou null : retour à l'affiche générée). */
export async function setCupPoster(id: string, body: unknown) {
  const posterUrl = parsePosterUrl((body as { posterUrl?: unknown } | undefined)?.posterUrl);
  unwrap(await supabase.from('tournaments').update({ poster_url: posterUrl }).eq('id', id).in('kind', ['horus', 'anubis']));
  return cupAdmin();
}

/** Affiche d'un rendez-vous récurrent (reprise par ses prochaines coupes), ou null. */
export async function setSchedulePoster(id: string, body: unknown) {
  const posterUrl = parsePosterUrl((body as { posterUrl?: unknown } | undefined)?.posterUrl);
  unwrap(await supabase.from('cup_schedules').update({ poster_url: posterUrl }).eq('id', id));
  return cupAdmin();
}

/**
 * Liste publique des coupes (page Tournoi, façon Sked) : prochaines coupes et tournoi de saison (prévus ou en cours,
 * par date), puis les dernières terminées avec leur vainqueur. Affiche, format, places prises.
 */
export async function listCups() {
  const kinds = ['horus', 'anubis', 'saison'];
  const [upcoming, past] = await Promise.all([
    supabase.from('tournaments').select('*').in('kind', kinds).in('status', ['scheduled', 'running']).order('starts_at').limit(20),
    supabase.from('tournaments').select('*').in('kind', kinds).eq('status', 'completed').order('completed_at', { ascending: false }).limit(9),
  ]);
  if (upcoming.error) throw fromDbError(upcoming.error);
  if (past.error) throw fromDbError(past.error);
  const rows = [...((upcoming.data ?? []) as TournamentRow[]), ...((past.data ?? []) as TournamentRow[])];
  const ids = rows.map((row) => row.id);
  const [teamRows, playerRows] = ids.length
    ? await Promise.all([
        supabase.from('tournament_teams').select('tournament_id').in('tournament_id', ids),
        supabase.from('cup_players').select('tournament_id').in('tournament_id', ids),
      ])
    : [{ data: [] }, { data: [] }];
  const count = (list: { tournament_id: string }[] | null, id: string) => (list ?? []).filter((row) => row.tournament_id === id).length;
  const winnerIds = rows.map((row) => row.winner_team).filter(Boolean) as string[];
  const winners = winnerIds.length
    ? ((unwrap(await supabase.from('teams').select('id, name, tag, color, logo_url').in('id', winnerIds)) ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null }[])
    : [];
  const view = (row: TournamentRow) => {
    const winner = winners.find((team) => team.id === row.winner_team);
    const anubis = row.kind === 'anubis';
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      startsAt: row.starts_at,
      completedAt: row.completed_at,
      checkInOpensAt: new Date(new Date(row.starts_at).getTime() - CHECKIN_MINUTES * 60_000).toISOString(),
      size: row.size,
      teamSize: playersPerTeam(row),
      bestOf: row.best_of,
      finalBestOf: row.final_best_of,
      bracket: row.bracket,
      // Coupe Anubis : joueurs inscrits sur la capacité ; sinon équipes sur les places.
      registered: anubis ? count(playerRows.data as { tournament_id: string }[] | null, row.id) : count(teamRows.data as { tournament_id: string }[] | null, row.id),
      capacity: anubis ? anubisCapacity(row.size, row.team_size ?? config.teams.rosterSize) : row.size,
      // Places de remplaçant en plus (inscrits au-delà de capacity), seulement pour les coupes ouvertes à l'inscription.
      reserveSlots: row.kind === 'anubis' ? anubisReserve(row.size, row.team_size ?? config.teams.rosterSize) : row.kind === 'horus' ? reserveTeams(row.size) : 0,
      posterUrl: posterOf(row),
      winner: winner ? { id: winner.id, name: winner.name, tag: winner.tag, color: winner.color, logoUrl: winner.logo_url } : null,
    };
  };
  return {
    upcoming: ((upcoming.data ?? []) as TournamentRow[]).map(view),
    past: ((past.data ?? []) as TournamentRow[]).map(view),
  };
}
