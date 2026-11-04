/** Ce qui attend le joueur : pastilles du menu du site. Règles pures, testées. */

export interface ClassicMatch {
  team_a: string[];
  team_b: string[];
  reported_by: string | null;
}

/** Match classé à confirmer : le résultat vient de l'équipe adverse. */
export function mustConfirmClassic(match: ClassicMatch, userId: string): boolean {
  if (!match.reported_by) return false;
  const mine = match.team_a.includes(userId) ? match.team_a : match.team_b.includes(userId) ? match.team_b : null;
  return Boolean(mine) && !mine!.includes(match.reported_by);
}

export interface TeamMatch {
  team_a: string;
  team_b: string;
  roster_a: string[];
  roster_b: string[];
  reported_team: 'A' | 'B' | null;
}

/** Match d'équipe à confirmer : déclaré par l'équipe adverse, par un joueur du match ou un Leader. */
export function mustConfirmTeam(match: TeamMatch, userId: string, teamId: string, isLeader: boolean): boolean {
  const side = match.team_a === teamId ? 'A' : match.team_b === teamId ? 'B' : null;
  if (!side || !match.reported_team || match.reported_team === side) return false;
  return isLeader || (side === 'A' ? match.roster_a : match.roster_b).includes(userId);
}
