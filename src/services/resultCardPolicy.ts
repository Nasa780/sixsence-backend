/** Adresses de la carte de résultat du bot Discord (image /api/og/resultat du site), sans base. */

export interface ResultCard {
  kind: 'classe' | 'division' | 'tournoi';
  label: string;
  map?: string | null;
  a: string;
  b: string;
  /** Joueurs de chaque équipe, en Classé (équipes sans nom). */
  playersA?: string[];
  playersB?: string[];
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
}

export function resultCardUrl(siteUrl: string, card: ResultCard): string {
  const query = new URLSearchParams({ k: card.kind, l: card.label, a: card.a, b: card.b, w: card.winner });
  if (card.map) query.set('map', card.map);
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
  for (const key of ['best', 'bs', 'bk']) parsed.searchParams.delete(key);
  if (best) {
    parsed.searchParams.set('best', best.username);
    parsed.searchParams.set('bs', String(best.score));
    parsed.searchParams.set('bk', String(best.kills));
  }
  return parsed.toString();
}
