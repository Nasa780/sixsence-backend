/**
 * Recherche de joueurs dans /admin : règles pures (testées dans playerSearch.test.ts).
 *
 * Les pseudos Discord sont souvent « stylisés » (𝑵ø𝒙𝒊ř𝒂, Zейø…) : on les ramène à des lettres
 * simples avant de comparer, pour qu'on puisse les retrouver en tapant « noxira » ou « zeyo ».
 * La recherche porte aussi sur l'identifiant Activision.
 */

/** Lettres qui ne se décomposent pas toutes seules (barrées, ligatures, sosies cyrilliques ou grecs). */
const LOOKALIKES: Record<string, string> = {
  ø: 'o', ł: 'l', đ: 'd', ħ: 'h', ŧ: 't', ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th', ð: 'd',
  // cyrillique
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', и: 'u', й: 'y', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ь: 'b', я: 'r',
  // grec
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};

/** Texte ramené à des lettres et chiffres simples, en minuscules (« 𓆩𝑵ø𝒙𝒊ř𝒂シ𓆪 » → « noxira »). */
export function normalizeName(text: string): string {
  // Sosies remplacés avant la décomposition (« й » deviendrait sinon « и » + accent), puis après.
  const swap = (value: string) => [...value].map((char) => LOOKALIKES[char] ?? char).join('');
  return swap(swap(text.normalize('NFKC').toLowerCase()).normalize('NFKD')).replace(/[^a-z0-9]/g, '');
}

export interface SearchablePlayer {
  username: string;
  activisionId: string | null;
  points: number;
}

/**
 * Score d'un joueur pour une recherche : 0 exact, 1 début, 2 contient (pseudo ou identifiant
 * Activision), null s'il ne correspond pas.
 */
export function matchScore(player: SearchablePlayer, query: string): number | null {
  const term = normalizeName(query);
  if (!term) return 3;
  let best: number | null = null;
  for (const field of [player.username, player.activisionId ?? '']) {
    const value = normalizeName(field);
    if (!value) continue;
    const score = value === term ? 0 : value.startsWith(term) ? 1 : value.includes(term) ? 2 : null;
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

/** Joueurs qui correspondent, les meilleurs d'abord (puis les plus de points, puis par pseudo). */
export function rankPlayers<T extends SearchablePlayer>(players: T[], query: string): T[] {
  return players
    .map((player) => ({ player, score: matchScore(player, query) }))
    .filter((entry): entry is { player: T; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || b.player.points - a.player.points || a.player.username.localeCompare(b.player.username, 'fr'))
    .map((entry) => entry.player);
}
