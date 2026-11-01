import { fromDbError } from '../errors.js';
import { supabase } from '../supabase.js';

/** Compteurs affichés sur la page d'accueil (« Statistiques du site »). */
export interface SiteStats {
  players: number;
  matchesPlayed: number;
  matchesInProgress: number;
  averagePoints: number;
}

/**
 * Le calcul fait cinq requêtes : on le garde en cache 30 secondes, la page
 * d'accueil étant la plus visitée du site.
 */
const CACHE_TTL_MS = 30_000;
let cached: { stats: SiteStats; expiresAt: number } | null = null;

export async function getSiteStats(): Promise<SiteStats> {
  if (cached && cached.expiresAt > Date.now()) return cached.stats;

  const [players, completed, inProgress, ranked, report] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('cod_matches').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
    supabase
      .from('cod_matches')
      .select('id', { count: 'exact', head: true })
      .in('status', ['in_progress', 'awaiting_confirmation']),
    supabase.from('cod_leaderboard').select('points').limit(1000),
    // Matchs joués avant la remise à zéro du lancement (période de test, archivés) : comptés dans les chiffres du
    // site seulement, jamais dans les stats des joueurs. app_state site_stats_offset = { "matchesPlayed": n }.
    supabase.from('app_state').select('value').eq('key', 'site_stats_offset').maybeSingle(),
  ]);
  for (const result of [players, completed, inProgress, ranked, report]) {
    if (result.error) throw fromDbError(result.error);
  }

  const points = ((ranked.data ?? []) as { points: number }[]).map((row) => row.points);
  const stats: SiteStats = {
    players: players.count ?? 0,
    matchesPlayed: (completed.count ?? 0) + reportedMatches(report.data?.value),
    matchesInProgress: inProgress.count ?? 0,
    averagePoints: points.length > 0 ? Math.round(points.reduce((sum, value) => sum + value, 0) / points.length) : 0,
  };

  cached = { stats, expiresAt: Date.now() + CACHE_TTL_MS };
  return stats;
}

function reportedMatches(value: unknown): number {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const n = Number((parsed as { matchesPlayed?: unknown } | null)?.matchesPlayed);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}
