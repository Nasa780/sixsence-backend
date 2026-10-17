/**
 * Rôles de l'équipe SixSence et droits sur l'administration (règles pures, testées
 * dans roles.test.ts).
 *   admin   : tout (gestion du site, rôles, événements, saison…)
 *   staff   : contestations, demandes d'arbitrage, signalements, sanctions et équipes
 *   arbitre : contestations et demandes d'arbitrage
 */

export type Role = 'member' | 'arbitre' | 'staff' | 'admin';
export const ROLES: Role[] = ['member', 'arbitre', 'staff', 'admin'];
/** Équipe qui tranche les matchs : contestations et demandes d'arbitrage. */
export const MATCH_REFEREES: Role[] = ['admin', 'staff', 'arbitre'];
/** Équipe de modération : signalements et sanctions. */
export const MODERATORS: Role[] = ['admin', 'staff'];

/** Rôles autorisés pour une route de /admin (chemin relatif : « /disputes »…). Le reste : admin. */
export function rolesFor(method: string, path: string): Role[] {
  if (path === '/overview' || path === '/disputes' || path === '/team-disputes' || (method === 'GET' && path === '/matches') || path.startsWith('/arbitrations') || /^\/matches\/[^/]+\/cancel$/.test(path)) {
    return MATCH_REFEREES;
  }
  if (path.startsWith('/reports') || path.startsWith('/teams') || path.startsWith('/team-reports') || (method === 'GET' && path === '/players') || /^\/players\/[^/]+\/sanctions$/.test(path) || path.startsWith('/sanctions/')) {
    return MODERATORS;
  }
  return ['admin'];
}
