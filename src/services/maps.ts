import { HttpError } from '../errors.js';
import { supabase } from '../supabase.js';

/**
 * Maps de Modern Warfare 4 et map pool de chaque mode (maps qui peuvent être tirées au sort) :
 *   classe    file classée (une map par match)
 *   division  matchs d'équipe et défis (BO3)
 *   tournoi   coupes Horus et Anubis, tournoi de fin de saison
 * Pools gardés dans app_state « map_pools » (réglés depuis l'admin), toutes les maps par défaut.
 * Les images vivent sur le site (public/images/maps/<id>.webp), même identifiant que `id`.
 */

export const MAP_CATALOG = [
  { id: 'cachette', name: 'Cachette' },
  { id: 'coal', name: 'Coal' },
  { id: 'lithium', name: 'Lithium' },
  { id: 'lotus', name: 'Lotus' },
  { id: 'mumbai', name: 'Mumbai' },
  { id: 'munition', name: 'Munition' },
  { id: 'nautical', name: 'Nautical' },
  { id: 'reactor-u92', name: 'Reactor U92' },
  { id: 'rooftops', name: 'Rooftops' },
  { id: 'secteur-lethal', name: 'Secteur Léthal' },
  { id: 'sentry', name: 'Sentry' },
  { id: 'silkworm', name: 'Silkworm' },
  { id: 'transit-213', name: 'Transit 213' },
] as const;

export const MAP_MODES = ['classe', 'division', 'tournoi'] as const;
export type MapMode = (typeof MAP_MODES)[number];
type Pools = Record<MapMode, string[]>;

const STATE_KEY = 'map_pools';
const ALL = MAP_CATALOG.map((map) => map.name);
let cache: { pools: Pools; at: number } | null = null;

/** Pools actuels (cache 60 s) ; une map retirée du catalogue disparaît des pools ; pool vide = toutes les maps. */
export async function mapPools(): Promise<Pools> {
  if (cache && Date.now() - cache.at < 60_000) return cache.pools;
  const { data } = await supabase.from('app_state').select('value').eq('key', STATE_KEY).maybeSingle();
  let saved: Partial<Record<MapMode, string[]>> = {};
  try {
    saved = JSON.parse((data as { value?: string } | null)?.value ?? '{}');
  } catch {
    saved = {};
  }
  const pools = Object.fromEntries(
    MAP_MODES.map((mode) => {
      const list = (saved[mode] ?? ALL).filter((name) => (ALL as string[]).includes(name));
      return [mode, list.length ? list : [...ALL]];
    }),
  ) as Pools;
  cache = { pools, at: Date.now() };
  return pools;
}

export async function mapPool(mode: MapMode): Promise<string[]> {
  return (await mapPools())[mode];
}

/** Catalogue et pools, pour la page « Map pool » du site et l'admin. */
export async function mapsOverview() {
  return { maps: MAP_CATALOG, pools: await mapPools() };
}

/** Admin : nouveaux pools { classe: [...], division: [...], tournoi: [...] } (2 maps au moins par mode, 3 en Division et Tournoi pour les BO3). */
export async function setMapPools(body: unknown) {
  const input = (body ?? {}) as Partial<Record<MapMode, unknown>>;
  const pools = {} as Pools;
  for (const mode of MAP_MODES) {
    const list = Array.isArray(input[mode]) ? (input[mode] as unknown[]).filter((name): name is string => typeof name === 'string' && (ALL as string[]).includes(name)) : [];
    const min = mode === 'classe' ? 2 : 3;
    if (new Set(list).size < min) throw new HttpError(400, 'INVALID_POOL', `Le pool ${mode === 'classe' ? 'Classé' : mode === 'division' ? 'Division' : 'Tournoi'} doit compter au moins ${min} maps.`);
    pools[mode] = [...new Set(list)];
  }
  const { error } = await supabase.from('app_state').upsert({ key: STATE_KEY, value: JSON.stringify(pools) });
  if (error) throw new HttpError(500, 'DB_ERROR', error.message);
  cache = { pools, at: Date.now() };
  return mapsOverview();
}
