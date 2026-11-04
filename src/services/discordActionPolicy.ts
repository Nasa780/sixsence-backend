/** Règles des commandes Discord /defi et /rappel, sans réseau ni base (testées dans discordActionPolicy.test.ts). */
import { CHECKIN_MINUTES } from './tournamentPolicy.js';

/** Identifiant du menu de choix des joueurs de /defi : équipe défiée, a = amical, o = officiel. */
export const defiActionId = (teamId: string, friendly: boolean) => `defi:${teamId}:${friendly ? 'a' : 'o'}`;

export function parseDefiAction(customId: unknown): { teamId: string; friendly: boolean } | null {
  const found = typeof customId === 'string' ? /^defi:([0-9a-f-]{36}):([ao])$/.exec(customId) : null;
  return found ? { teamId: found[1]!, friendly: found[2] === 'a' } : null;
}

/** Le rappel part à l'ouverture du check-in (2 h avant), et jusqu'au début de la coupe si le serveur était en veille. */
export function reminderDue(startsAt: string, now: number): boolean {
  const start = new Date(startsAt).getTime();
  return now < start && start - now <= CHECKIN_MINUTES * 60_000;
}
