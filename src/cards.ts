/**
 * Cartes de visite : catalogue et règles d'obtention (fonctions pures, testées dans
 * cards.test.ts). Le site dessine les cartes (src/lib/cards.js) à partir des mêmes clés.
 *
 * Familles : par défaut, rangs (pic atteint), succès, saison (3 par saison, exclusives),
 * MVP (MVP du mois : une carte par mois, regroupées ; MVP ×10), communauté, GTA 6.
 * Une carte obtenue est définitive, sauf Partenaire et Staff (retirées avec le badge ou le rôle).
 */

export type Rarity = 'commune' | 'rare' | 'epique' | 'legendaire';

/** Statistiques d'un joueur sur toute sa carrière (toutes saisons confondues). */
export interface CardStats {
  /** Plus haut total de points atteint (pic de la saison en cours ou points d'une saison archivée). */
  peak: number;
  wins: number;
  played: number;
  bestStreak: number;
  formatsWon: string[];
  groupWins: number;
  soloWins: number;
  /** Matchs dont le joueur a été MVP (co-MVP compris). */
  mvpMatches: number;
  /** Mois où il a été MVP du mois (« 2026-10 »). */
  mvpMonths: string[];
  /** Saisons archivées : classement final et matchs joués. */
  seasons: { id: number; position: number | null; played: number }[];
  badges: string[];
  /** Membre de l'équipe SixSence (admin, staff ou arbitre). */
  team: boolean;
  /** Inscriptions à des événements GTA 6 terminés. */
  gtaEvents: number;
}

export interface CardDef {
  key: string;
  family: string;
  name: string;
  condition: string;
  rarity: Rarity;
  /** Plus jamais obtenable une fois la période passée (saison, mois, fondateurs, bêta). */
  exclusive?: boolean;
  /** Suit un statut actuel : retirée si la condition n'est plus remplie. */
  removable?: boolean;
  eligible: (stats: CardStats) => boolean;
  /** Progression [actuel, objectif] pour les cartes verrouillées. */
  progress?: (stats: CardStats) => [number, number];
}

export const DEFAULT_CARD = 'sixsence';
/** Case unique qui regroupe toutes les cartes « MVP du mois ». */
export const MVP_MONTH_CARD = 'mvp-du-mois';
/** Formats comptés pour « Polyvalent » (la file 1v1 de test est ignorée). */
export const RANKED_FORMATS = ['2v2', '3v3', '4v4', '5v5'];

const RANK_CARDS: { name: string; key: string; min: number; rarity: Rarity }[] = [
  { name: 'Argent', key: 'argent', min: 300, rarity: 'commune' },
  { name: 'Or', key: 'or', min: 600, rarity: 'commune' },
  { name: 'Platine', key: 'platine', min: 900, rarity: 'rare' },
  { name: 'Diamant', key: 'diamant', min: 1200, rarity: 'rare' },
  { name: 'Maître', key: 'maitre', min: 1500, rarity: 'epique' },
  { name: 'Grand Maître', key: 'grand-maitre', min: 1800, rarity: 'epique' },
  { name: 'Champion', key: 'champion', min: 2100, rarity: 'legendaire' },
  { name: 'Légende', key: 'legende', min: 3000, rarity: 'legendaire' },
];

const count = (value: (stats: CardStats) => number, goal: number) => ({
  eligible: (stats: CardStats) => value(stats) >= goal,
  progress: (stats: CardStats): [number, number] => [Math.min(value(stats), goal), goal],
});

/** Cartes permanentes du catalogue (hors cartes de saison et mois MVP, générées). */
export const STATIC_CARDS: CardDef[] = [
  { key: DEFAULT_CARD, family: 'Par défaut', name: 'SixSence', condition: 'Carte de départ', rarity: 'commune', eligible: () => true },
  ...RANK_CARDS.map((rank) => ({
    key: `rang-${rank.key}`,
    family: 'Rangs',
    name: rank.name,
    condition: `Atteindre ${rank.name}`,
    rarity: rank.rarity,
    ...count((stats) => stats.peak, rank.min),
  })),
  { key: 'premier-sang', family: 'Succès', name: 'Premier sang', condition: '1re victoire', rarity: 'commune', ...count((s) => s.wins, 1) },
  { key: 'domination', family: 'Succès', name: 'Domination', condition: '10 victoires', rarity: 'commune', ...count((s) => s.wins, 10) },
  { key: 'veteran', family: 'Succès', name: 'Vétéran', condition: '50 matchs joués', rarity: 'commune', ...count((s) => s.played, 50) },
  { key: 'indestructible', family: 'Succès', name: 'Indestructible', condition: "5 victoires d'affilée", rarity: 'rare', ...count((s) => s.bestStreak, 5) },
  { key: 'esprit-equipe', family: 'Succès', name: "Esprit d'équipe", condition: '25 victoires en groupe', rarity: 'rare', ...count((s) => s.groupWins, 25) },
  { key: 'loup-solitaire', family: 'Succès', name: 'Loup solitaire', condition: '25 victoires en solo', rarity: 'rare', ...count((s) => s.soloWins, 25) },
  {
    key: 'polyvalent',
    family: 'Succès',
    name: 'Polyvalent',
    condition: '1 victoire dans chaque format',
    rarity: 'rare',
    ...count((s) => RANKED_FORMATS.filter((format) => s.formatsWon.includes(format)).length, RANKED_FORMATS.length),
  },
  { key: 'centurion', family: 'Succès', name: 'Centurion', condition: '100 victoires', rarity: 'epique', ...count((s) => s.wins, 100) },
  { key: 'invaincu', family: 'Succès', name: 'Invaincu', condition: "10 victoires d'affilée", rarity: 'epique', ...count((s) => s.bestStreak, 10) },
  {
    key: MVP_MONTH_CARD,
    family: 'MVP',
    name: 'MVP du mois',
    condition: 'Être élu MVP du mois',
    rarity: 'legendaire',
    exclusive: true,
    eligible: (s) => s.mvpMonths.length > 0,
  },
  { key: 'mvp-10', family: 'MVP', name: 'MVP ×10', condition: 'MVP de 10 matchs', rarity: 'rare', ...count((s) => s.mvpMatches, 10) },
  { key: 'fondateur', family: 'Communauté', name: 'Fondateur', condition: 'Membre fondateur', rarity: 'legendaire', exclusive: true, eligible: (s) => s.badges.includes('founder') },
  { key: 'beta', family: 'Communauté', name: 'Bêta-testeur', condition: 'A testé la bêta', rarity: 'rare', exclusive: true, eligible: (s) => s.badges.includes('beta') },
  { key: 'partenaire', family: 'Communauté', name: 'Partenaire', condition: 'Partenaire SixSence', rarity: 'rare', removable: true, eligible: (s) => s.badges.includes('partner') },
  { key: 'staff-6', family: 'Communauté', name: 'Staff', condition: "Membre de l'équipe", rarity: 'rare', removable: true, eligible: (s) => s.team },
  { key: 'premiere-viree', family: 'GTA 6', name: 'Première virée', condition: '1 événement GTA 6', rarity: 'commune', ...count((s) => s.gtaEvents, 1) },
  { key: 'habitue', family: 'GTA 6', name: 'Habitué', condition: '5 événements GTA 6', rarity: 'rare', ...count((s) => s.gtaEvents, 5) },
];

/** Les trois cartes d'une saison (exclusives, attribuées à la clôture). */
export function seasonCards(seasonId: number): CardDef[] {
  const of = (stats: CardStats) => stats.seasons.find((season) => season.id === seasonId);
  return [
    {
      key: `s${seasonId}-participant`,
      family: `Saison ${seasonId}`,
      name: `Participant S${seasonId}`,
      condition: `10 matchs dans la saison ${seasonId}`,
      rarity: 'commune',
      exclusive: true,
      eligible: (s) => (of(s)?.played ?? 0) >= 10,
    },
    {
      key: `s${seasonId}-top10`,
      family: `Saison ${seasonId}`,
      name: `Top 10 S${seasonId}`,
      condition: 'Finir dans le top 10',
      rarity: 'epique',
      exclusive: true,
      eligible: (s) => {
        const position = of(s)?.position;
        return position !== null && position !== undefined && position <= 10;
      },
    },
    {
      key: `s${seasonId}-champion`,
      family: `Saison ${seasonId}`,
      name: `Champion S${seasonId}`,
      condition: 'Finir n°1 de la saison',
      rarity: 'legendaire',
      exclusive: true,
      eligible: (s) => of(s)?.position === 1,
    },
  ];
}

/** Toutes les cartes qu'un joueur mérite, d'après ses statistiques. */
export function eligibleKeys(stats: CardStats): string[] {
  const keys = STATIC_CARDS.filter((card) => card.eligible(stats)).map((card) => card.key);
  for (const season of stats.seasons) {
    for (const card of seasonCards(season.id)) if (card.eligible(stats)) keys.push(card.key);
  }
  return keys;
}

/** Une carte équipable : obtenue, ou la carte par défaut. */
export function canEquip(key: string, owned: string[]): boolean {
  return key === DEFAULT_CARD || owned.includes(key);
}

/** Cartes à retirer : celles qui suivent un statut que le joueur n'a plus. */
export function revokedKeys(owned: string[], stats: CardStats): string[] {
  return STATIC_CARDS.filter((card) => card.removable && owned.includes(card.key) && !card.eligible(stats)).map((card) => card.key);
}

/** Meilleure série de victoires dans une suite de résultats (dans l'ordre chronologique). */
export function longestStreak(results: boolean[]): number {
  let best = 0;
  let current = 0;
  for (const won of results) {
    current = won ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

/**
 * MVP d'un match (mêmes règles que le site) : le plus voté ; à égalité, les votes reçus des
 * autres joueurs départagent ; sinon co-MVP.
 */
export function mvpOf(votes: { voter_id: string; target_id: string }[]): string[] {
  const tally = (list: typeof votes) => {
    const map = new Map<string, number>();
    for (const vote of list) map.set(vote.target_id, (map.get(vote.target_id) ?? 0) + 1);
    return map;
  };
  const total = tally(votes);
  const top = Math.max(0, ...total.values());
  if (top === 0) return [];
  const leaders = [...total.entries()].filter(([, n]) => n === top).map(([id]) => id);
  if (leaders.length === 1) return leaders;
  const others = tally(votes.filter((vote) => vote.voter_id !== vote.target_id));
  const best = Math.max(...leaders.map((id) => others.get(id) ?? 0));
  return leaders.filter((id) => (others.get(id) ?? 0) === best);
}

export function findCard(key: string, seasonIds: number[]): CardDef | undefined {
  return STATIC_CARDS.find((card) => card.key === key) ?? seasonIds.flatMap(seasonCards).find((card) => card.key === key);
}
