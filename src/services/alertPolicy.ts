/**
 * Alertes d'erreurs : règles anti-spam pures (testées dans alertPolicy.test.ts).
 *
 * Une même erreur (même « signature ») n'est signalée qu'une fois par fenêtre ;
 * les répétitions sont comptées et annoncées avec l'alerte suivante. Un plafond
 * horaire global évite d'inonder le salon si tout casse en même temps.
 */

export interface AlertRules {
  /** Délai minimal entre deux alertes de même signature. */
  repeatMs: number;
  /** Alertes au plus par heure, toutes signatures confondues. */
  maxPerHour: number;
}

export interface AlertDecision {
  send: boolean;
  /** Occurrences de cette erreur non signalées depuis la dernière alerte. */
  suppressed: number;
}

/** Signature d'une erreur : chiffres, identifiants et adresses neutralisés. */
export function signatureOf(source: string, message: string, where = ''): string {
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
      .replace(/https?:\/\/\S+/g, '<url>')
      .replace(/\d+/g, '<n>')
      .slice(0, 200);
  return `${source}|${normalize(where)}|${normalize(message)}`;
}

/** Crée un filtre d'alertes avec sa propre mémoire. */
export function createAlertThrottle(rules: AlertRules) {
  const lastSent = new Map<string, number>();
  const suppressed = new Map<string, number>();
  let sentTimes: number[] = [];

  return function decide(signature: string, now: number): AlertDecision {
    sentTimes = sentTimes.filter((time) => now - time < 60 * 60_000);
    const last = lastSent.get(signature);
    if ((last !== undefined && now - last < rules.repeatMs) || sentTimes.length >= rules.maxPerHour) {
      suppressed.set(signature, (suppressed.get(signature) ?? 0) + 1);
      return { send: false, suppressed: 0 };
    }
    const count = suppressed.get(signature) ?? 0;
    suppressed.delete(signature);
    if (lastSent.size > 500) lastSent.clear();
    lastSent.set(signature, now);
    sentTimes.push(now);
    return { send: true, suppressed: count };
  };
}

/** Erreurs du navigateur sans intérêt (extensions, coupures réseau, onglets fermés…). */
const NOISE = [
  /resizeobserver loop/i,
  /^script error\.?$/i,
  /chrome-extension|moz-extension|safari-extension|safari-web-extension/i,
  /failed to fetch|load failed|networkerror|network request failed/i,
  /loading chunk \S+ failed|chunkloaderror|failed to fetch dynamically imported module|importing a module script failed/i,
  /aborterror|the operation was aborted/i,
  /notallowederror/i,
];

export function isNoise(message: string): boolean {
  return NOISE.some((pattern) => pattern.test(message));
}
