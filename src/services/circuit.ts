import { unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { CIRCUIT_POINTS, DIVISION_SPOTS, circuitProjection, circuitStandings, type CircuitCup } from './circuitPolicy.js';
import { fourthPlace, type BracketEntry } from './tournamentPolicy.js';

/**
 * Circuit SixSence (GET /teams/circuit, page /cod/circuit) : classement des points gagnés dans les Coupes Horus
 * terminées de la saison active (règles dans circuitPolicy.ts). Sert aussi à qualifier les équipes du tournoi de
 * fin de saison (tournaments.ts). En mémoire 60 s.
 */

const DEFAULT_FINAL_SIZE = 8;
let cache: { at: number; data: Awaited<ReturnType<typeof compute>> } | null = null;

async function activeSeason() {
  return unwrap(await supabase.from('seasons').select('id, name, ends_at').eq('is_active', true).maybeSingle()) as { id: number; name: string | null; ends_at: string | null } | null;
}

async function compute() {
  const season = await activeSeason();
  if (!season) return { season: null, cups: [], played: [] as CircuitCup[], standings: [] as ReturnType<typeof circuitStandings> };
  const cups = (unwrap(
    await supabase.from('tournaments').select('id, name, status, starts_at, completed_at, winner_team, finalist_team, third_team, size, bracket').eq('kind', 'horus').eq('season_id', season.id).in('status', ['scheduled', 'running', 'completed']).order('starts_at'),
  ) ?? []) as {
    id: string;
    name: string;
    status: string;
    starts_at: string;
    completed_at: string | null;
    winner_team: string | null;
    finalist_team: string | null;
    third_team: string | null;
    size: number;
    bracket: 'single' | 'double';
  }[];
  const done = cups.filter((c) => c.status === 'completed');
  const present = done.length
    ? ((unwrap(await supabase.from('tournament_teams').select('tournament_id, team_id').in('tournament_id', done.map((c) => c.id)).not('checked_in_at', 'is', null)) ?? []) as { tournament_id: string; team_id: string }[])
    : [];
  // 4e place relue dans le tableau de chaque coupe (aussi pour les coupes jouées avant son ajout).
  const entries = done.length
    ? ((unwrap(await supabase.from('tournament_bracket').select('tournament_id, round, slot, team_a, team_b, winner, status').in('tournament_id', done.map((c) => c.id))) ?? []) as {
        tournament_id: string;
        round: number;
        slot: number;
        team_a: string | null;
        team_b: string | null;
        winner: string | null;
        status: BracketEntry['status'];
      }[])
    : [];
  const played: CircuitCup[] = done.map((c) => ({
    winner: c.winner_team,
    finalist: c.finalist_team,
    third: c.third_team,
    fourth: fourthPlace(
      entries.filter((e) => e.tournament_id === c.id).map((e) => ({ round: e.round, slot: e.slot, teamA: e.team_a, teamB: e.team_b, winner: e.winner, status: e.status })),
      c.size,
      c.bracket,
    ),
    present: present.filter((p) => p.tournament_id === c.id).map((p) => p.team_id),
  }));
  return { season, cups, played, standings: circuitStandings(played) };
}

async function data() {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  cache = { at: Date.now(), data: await compute() };
  return cache.data;
}

/** Équipes du circuit, de la première à la dernière (qualification de la grande finale). */
export async function circuitOrder(): Promise<string[]> {
  cache = null;
  return (await data()).standings.map((s) => s.teamId);
}

/** Place au circuit des équipes d'une Coupe Horus à venir ou en cours, et place en cas de victoire (fiche de la coupe). */
export async function circuitOutlook(teamIds: string[]) {
  return circuitProjection((await data()).played, teamIds);
}

/** Page du circuit : barème, coupes de la saison, classement avec les zones de la grande finale. */
export async function getCircuit() {
  const { season, cups, standings } = await data();
  const final = unwrap(await supabase.from('tournaments').select('id, name, size, starts_at, status').eq('kind', 'saison').in('status', ['scheduled', 'running']).maybeSingle()) as {
    id: string;
    name: string;
    size: number;
    starts_at: string;
    status: string;
  } | null;
  const finalSize = final?.size ?? DEFAULT_FINAL_SIZE;
  const { playInOverview } = await import('./tournaments.js');
  const playIn = await playInOverview(finalSize).catch(() => null);
  const ids = standings.map((s) => s.teamId);
  const teams = ids.length
    ? ((unwrap(await supabase.from('teams').select('id, name, tag, color, logo_url, disbanded_at').in('id', ids)) ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null; disbanded_at: string | null }[])
    : [];
  const byId = new Map(teams.map((t) => [t.id, t]));
  return {
    season: season ? { id: season.id, name: season.name, endsAt: season.ends_at } : null,
    points: CIRCUIT_POINTS,
    finalSize,
    circuitSpots: finalSize - DIVISION_SPOTS,
    divisionSpots: DIVISION_SPOTS,
    final: final ? { id: final.id, name: final.name, startsAt: final.starts_at, status: final.status } : null,
    playIn,
    cups: cups.map((c) => ({ id: c.id, name: c.name, status: c.status, startsAt: c.starts_at, winner: c.winner_team ? byId.get(c.winner_team)?.name ?? null : null })),
    standings: standings
      .filter((s) => byId.has(s.teamId))
      .map((s) => {
        const t = byId.get(s.teamId)!;
        return { team: { id: t.id, name: t.name, tag: t.tag, color: t.color, logoUrl: t.logo_url, disbanded: Boolean(t.disbanded_at) }, points: s.points, cups: s.cups, podiums: s.podiums };
      }),
  };
}
