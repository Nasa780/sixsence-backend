/**
 * Circuit SixSence (règles pures, testées dans circuitPolicy.test.ts) : chaque Coupe Horus terminée de la saison
 * rapporte des points de circuit (or, argent, bronze, équipes présentes au check-in) ; le tournoi de fin de saison
 * (grande finale) prend les meilleures équipes du circuit, et garde ses 2 dernières places pour les meilleures
 * équipes de la Division pas encore qualifiées (la seconde chance).
 */

export const CIRCUIT_POINTS = { winner: 100, finalist: 70, third: 50, present: 15 } as const;
/** Places de la grande finale réservées à la Division. */
export const DIVISION_SPOTS = 2;

export interface CircuitCup {
  winner: string | null;
  finalist: string | null;
  third: string | null;
  /** Équipes présentes au check-in. */
  present: string[];
}

export interface CircuitStanding {
  teamId: string;
  points: number;
  cups: number;
  podiums: { winner: number; finalist: number; third: number };
}

/** Points de circuit de chaque équipe, du premier au dernier (égalité : le plus de victoires, puis de podiums). */
export function circuitStandings(cups: CircuitCup[]): CircuitStanding[] {
  const rows = new Map<string, CircuitStanding>();
  const row = (teamId: string) => {
    if (!rows.has(teamId)) rows.set(teamId, { teamId, points: 0, cups: 0, podiums: { winner: 0, finalist: 0, third: 0 } });
    return rows.get(teamId)!;
  };
  for (const cup of cups) {
    const podium = new Map<string, keyof CircuitStanding['podiums']>();
    if (cup.winner) podium.set(cup.winner, 'winner');
    if (cup.finalist) podium.set(cup.finalist, 'finalist');
    if (cup.third) podium.set(cup.third, 'third');
    for (const teamId of new Set([...cup.present, ...podium.keys()])) {
      const r = row(teamId);
      const place = podium.get(teamId);
      r.cups += 1;
      r.points += place ? CIRCUIT_POINTS[place] : CIRCUIT_POINTS.present;
      if (place) r.podiums[place] += 1;
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.podiums.winner - a.podiums.winner ||
      b.podiums.winner + b.podiums.finalist + b.podiums.third - (a.podiums.winner + a.podiums.finalist + a.podiums.third) ||
      a.teamId.localeCompare(b.teamId),
  );
}

/**
 * Qualifiés de la grande finale : les `size - 2` premières équipes du circuit (encore actives), puis les meilleures
 * de la Division pas encore qualifiées (déjà triées et filtrées par l'appelant) jusqu'à remplir les places ; places
 * du circuit inoccupées = plus de places pour la Division. Ordre = têtes de série.
 */
export function finalQualified<T extends { id: string }>(circuit: string[], division: T[], size: number, activeIds: Set<string>): { teamId: string; via: 'circuit' | 'division' }[] {
  const fromCircuit = circuit.filter((id) => activeIds.has(id)).slice(0, Math.max(0, size - DIVISION_SPOTS));
  const taken = new Set(fromCircuit);
  const fromDivision = division.filter((team) => !taken.has(team.id)).slice(0, size - fromCircuit.length);
  return [...fromCircuit.map((teamId) => ({ teamId, via: 'circuit' as const })), ...fromDivision.map((team) => ({ teamId: team.id, via: 'division' as const }))];
}

/**
 * Play-in (veille de la grande finale) : les 2 dernières places du circuit (`size - 1` et `size`) affrontent les 2
 * meilleures équipes de la Division pas encore qualifiées : dernière place du circuit contre la meilleure de la
 * Division, avant-dernière contre la 2e. Null s'il manque une équipe (places directes, finalQualified).
 */
export function playInPairs<T extends { id: string }>(circuit: string[], division: T[], size: number, activeIds: Set<string>): { direct: string[]; pairs: [string, string][] } | null {
  const active = circuit.filter((id) => activeIds.has(id));
  const direct = active.slice(0, Math.max(0, size - DIVISION_SPOTS));
  const challengers = active.slice(direct.length, size);
  if (direct.length !== size - DIVISION_SPOTS || challengers.length !== DIVISION_SPOTS) return null;
  const taken = new Set([...direct, ...challengers]);
  const fromDivision = division.filter((team) => !taken.has(team.id)).slice(0, DIVISION_SPOTS).map((team) => team.id);
  if (fromDivision.length !== DIVISION_SPOTS) return null;
  return { direct, pairs: [[challengers[0]!, fromDivision[1]!], [challengers[1]!, fromDivision[0]!]] };
}

/** Qualifiés de la grande finale après un play-in : places directes du circuit puis les vainqueurs du play-in. */
export function finalWithPlayIn(direct: string[], winners: (string | null)[], activeIds: Set<string>): { teamId: string; via: 'circuit' | 'playin' }[] {
  const seen = new Set<string>();
  const keep = (id: string | null): id is string => Boolean(id && activeIds.has(id) && !seen.has(id) && seen.add(id));
  return [...direct.filter(keep).map((teamId) => ({ teamId, via: 'circuit' as const })), ...winners.filter(keep).map((teamId) => ({ teamId, via: 'playin' as const }))];
}
