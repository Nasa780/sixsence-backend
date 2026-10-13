/**
 * Matchmaking par groupes : choisit, dans la file d'un format (2v2, 5v5…), les
 * groupes qui formeront deux équipes complètes.
 *
 * Règles :
 *   - les joueurs sont choisis dans l'ordre d'arrivée (findMatch) ; leur répartition
 *     entre les deux équipes est ensuite entièrement tirée au sort (randomSplit) ;
 *   - un groupe (solo, duo, trio…) n'est jamais séparé : tous ses membres
 *     jouent dans la même équipe ;
 *   - le groupe le plus ancien de la file est toujours servi en premier. S'il est
 *     impossible à placer pour l'instant (ex. un groupe de 4 en 5v5 sans solo
 *     disponible pour compléter), on passe au suivant pour ne pas bloquer la file,
 *     et il reste en tête pour le prochain match ;
 *   - à ancienneté égale, on préfère les groupes arrivés en premier.
 *
 * Fonction pure (aucun accès à la base) : la création du match en SQL revérifie
 * tout de façon atomique (cod_create_group_match), et cette logique est testée
 * dans matchmaker.test.ts.
 */

export interface QueueGroup {
  /** Identifiant du groupe dans la file (group_id). */
  id: string;
  members: string[];
  /** Date d'entrée dans la file (millisecondes). */
  joinedAt: number;
}

export interface MatchProposal {
  teamA: QueueGroup[];
  teamB: QueueGroup[];
}

interface Options {
  /** Nombre maximal de groupes examinés (les plus anciens). */
  maxGroups?: number;
  /** Budget de recherche, pour garantir un temps de calcul borné. */
  maxSteps?: number;
}

export function findMatch(queue: QueueGroup[], teamSize: number, options: Options = {}): MatchProposal | null {
  const maxGroups = options.maxGroups ?? 40;
  const maxSteps = options.maxSteps ?? 50_000;
  if (teamSize < 1) return null;

  const groups = queue
    .filter((group) => group.members.length >= 1 && group.members.length <= teamSize)
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
    .slice(0, maxGroups);

  const total = groups.reduce((sum, group) => sum + group.members.length, 0);
  if (total < teamSize * 2) return null;

  // Places restantes après l'indice i (pour couper les branches sans issue).
  const suffix = new Array<number>(groups.length + 1).fill(0);
  for (let i = groups.length - 1; i >= 0; i -= 1) suffix[i] = (suffix[i + 1] ?? 0) + (groups[i]?.members.length ?? 0);

  let steps = 0;

  for (let anchor = 0; anchor < groups.length; anchor += 1) {
    if ((suffix[anchor] ?? 0) < teamSize * 2) break;
    const first = groups[anchor];
    if (!first) break;

    const teamA: QueueGroup[] = [first];
    const teamB: QueueGroup[] = [];

    const search = (index: number, freeA: number, freeB: number): boolean => {
      if (freeA === 0 && freeB === 0) return true;
      steps += 1;
      if (steps > maxSteps || index >= groups.length) return false;
      if ((suffix[index] ?? 0) < freeA + freeB) return false;

      const group = groups[index];
      if (!group) return false;
      const size = group.members.length;

      // On essaie d'abord l'équipe la moins remplie, puis l'autre, puis de laisser le groupe en file.
      const order: Array<'A' | 'B'> = freeA >= freeB ? ['A', 'B'] : ['B', 'A'];
      for (const side of order) {
        const free = side === 'A' ? freeA : freeB;
        if (size > free) continue;
        const team = side === 'A' ? teamA : teamB;
        team.push(group);
        if (search(index + 1, side === 'A' ? freeA - size : freeA, side === 'B' ? freeB - size : freeB)) return true;
        team.pop();
      }
      return search(index + 1, freeA, freeB);
    };

    if (search(anchor + 1, teamSize - first.members.length, teamSize)) {
      return { teamA: [...teamA], teamB: [...teamB] };
    }
    if (steps > maxSteps) return null;
  }
  return null;
}

/**
 * Répartition tirée au sort : parmi toutes les façons de partager les groupes choisis
 * en deux équipes complètes (sans jamais séparer un groupe), en prend une au hasard,
 * avec la même chance pour chacune. L'ordre des groupes dans chaque équipe est aussi
 * mélangé (le premier joueur de l'équipe A est l'hôte de la partie).
 * random : générateur dans [0, 1[ (remplaçable dans les tests).
 */
export function randomSplit(proposal: MatchProposal, teamSize: number, random: () => number = Math.random): MatchProposal {
  const groups = [...proposal.teamA, ...proposal.teamB];
  // Au plus 10 groupes (5v5 en solos) : 1 024 combinaisons, examinées instantanément.
  const splits: number[] = [];
  for (let mask = 0; mask < 1 << groups.length; mask += 1) {
    let size = 0;
    groups.forEach((group, index) => {
      if (mask & (1 << index)) size += group.members.length;
    });
    if (size === teamSize) splits.push(mask);
  }
  if (splits.length === 0) return proposal;

  const mask = splits[Math.floor(random() * splits.length)] ?? splits[0]!;
  const shuffle = (list: QueueGroup[]) => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };
  return {
    teamA: shuffle(groups.filter((_, index) => mask & (1 << index))),
    teamB: shuffle(groups.filter((_, index) => !(mask & (1 << index)))),
  };
}

/** Membres d'une liste de groupes, dans l'ordre. */
export function membersOf(groups: QueueGroup[]): string[] {
  return groups.flatMap((group) => group.members);
}
