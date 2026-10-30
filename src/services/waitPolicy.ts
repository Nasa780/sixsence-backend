/**
 * Attentes de l'équipe SixSence (règles pures, testées dans waitPolicy.test.ts) : durée lisible des relances et délai
 * de l'alerte rapide des coupes.
 */

/** Une rencontre de coupe bloquée (contestation, match annulé) prévient le staff au bout de 5 min. */
export const CUP_ALERT_MINUTES = 5;
/** Forfait déclaré en coupe : l'équipe visée a 15 min pour répondre, puis l'alerte part 5 min plus tard. */
export const CUP_FORFEIT_ALERT_MINUTES = 15 + CUP_ALERT_MINUTES;

/** Durée d'attente lisible : « 45 min », « 4 h 10 », « 1 j 3 h ». */
export function waitedFor(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
  return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}
