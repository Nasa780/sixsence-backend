/** Adresses de la carte de résultat du bot Discord (image /api/og/resultat du site), sans base. */

export interface ResultCard {
  kind: 'classe' | 'division' | 'tournoi';
  label: string;
  /** Tour de la coupe (« Quarts de finale »). */
  phase?: string | null;
  map?: string | null;
  a: string;
  b: string;
  /** Joueurs de chaque équipe, en Classé (équipes sans nom). */
  playersA?: string[];
  playersB?: string[];
  /** Points de chaque équipe en Division (« +25 ») ; en Classé, ils restent sur la feuille de match. */
  pointsA?: string | null;
  pointsB?: string | null;
  /** Logos, en Division et en coupe. */
  logoA?: string | null;
  logoB?: string | null;
  winner: 'A' | 'B';
  /** Maps gagnées par chaque équipe, en Division et en tournoi. */
  series?: [number, number];
  /** Score de chaque map, en Division et en tournoi. */
  maps?: { name: string; score: [number, number] }[];
  forfeit?: boolean;
}

export interface BestLine {
  username: string;
  score: number;
  kills: number;
  plants?: number;
  defuses?: number;
  avatarUrl?: string | null;
}

export const signedPoints = (value: number) => `${value >= 0 ? '+' : ''}${value}`;

export function resultCardUrl(siteUrl: string, card: ResultCard): string {
  const query = new URLSearchParams({ k: card.kind, l: card.label, a: card.a, b: card.b, w: card.winner });
  if (card.phase) query.set('ph', card.phase);
  if (card.map) query.set('map', card.map);
  if (card.pointsA) query.set('ga', card.pointsA);
  if (card.pointsB) query.set('gb', card.pointsB);
  if (card.logoA) query.set('la', card.logoA);
  if (card.logoB) query.set('lb', card.logoB);
  if (card.playersA?.length) query.set('pa', card.playersA.join(' · '));
  if (card.playersB?.length) query.set('pb', card.playersB.join(' · '));
  if (card.series) query.set('s', card.series.join('-'));
  if (card.maps?.length) query.set('m', card.maps.map(({ name, score }) => `${name}:${score.join('-')}`).join(','));
  if (card.forfeit) query.set('f', '1');
  return `${siteUrl}/api/og/resultat?${query.toString()}`;
}

/** Ajoute, change ou retire le meilleur joueur sur une carte déjà publiée. */
export function withBestPlayer(url: string, best: BestLine | null): string {
  const parsed = new URL(url);
  for (const key of ['best', 'bs', 'bk', 'bp', 'bd', 'ba']) parsed.searchParams.delete(key);
  if (best) {
    parsed.searchParams.set('best', best.username);
    parsed.searchParams.set('bs', String(best.score));
    parsed.searchParams.set('bk', String(best.kills));
    parsed.searchParams.set('bp', String(best.plants ?? 0));
    parsed.searchParams.set('bd', String(best.defuses ?? 0));
    if (best.avatarUrl) parsed.searchParams.set('ba', best.avatarUrl);
  }
  return parsed.toString();
}

/** Score de manches lu sur la capture, en Classé : le plus haut revient au vainqueur de la carte. Null : retiré. */
export function withRoundScore(url: string, rounds: number[] | null): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('s');
  if (rounds) {
    const high = Math.max(...rounds);
    const low = Math.min(...rounds);
    parsed.searchParams.set('s', parsed.searchParams.get('w') === 'B' ? `${low}-${high}` : `${high}-${low}`);
  }
  return parsed.toString();
}
