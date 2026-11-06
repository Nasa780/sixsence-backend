/**
 * Correction d'un match terminé : règles pures (testées dans correctionPolicy.test.ts).
 *
 *   - un joueur du match peut demander une correction pendant 24 h après la validation ;
 *   - l'équipe (staff, arbitre) peut corriger pendant 48 h, l'admin sans limite.
 */

import type { Role } from '../roles.js';

/** Délai pour qu'un joueur demande une correction après la validation. */
export const PLAYER_CORRECTION_HOURS = 24;
/** Délai pour que le staff ou un arbitre corrige un match terminé. */
export const STAFF_CORRECTION_HOURS = 48;

/** Délai de correction selon le rôle : null = sans limite (admin). */
export function correctionWindowHours(role: Role): number | null {
  return role === 'admin' ? null : STAFF_CORRECTION_HOURS;
}

const TEAM_PLAYED = ['in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed'];

/** Match de Division ou de coupe : demande d'arbitrage pendant le match, de correction 24 h après (un amical ne se corrige pas). */
export function teamArbitrationOpen(status: string, completedAt: string | null, friendly: boolean, now = Date.now()): boolean {
  if (TEAM_PLAYED.includes(status)) return true;
  return status === 'completed' && !friendly && withinWindow(completedAt, PLAYER_CORRECTION_HOURS, now);
}

/** Un match terminé à completedAt peut-il encore être corrigé avec ce délai (en heures) ? */
export function withinWindow(completedAt: string | null, hours: number | null, now = Date.now()): boolean {
  if (hours === null) return true;
  if (!completedAt) return false;
  return now - new Date(completedAt).getTime() <= hours * 3_600_000;
}
