import { config } from '../config.js';
import { createAlertThrottle, signatureOf } from './alertPolicy.js';
import { discord, discordEnabled, SUPPRESS_EMBEDS } from './discord.js';

/**
 * Surveillance des erreurs : les erreurs inattendues du serveur et du site sont
 * signalées dans un salon Discord privé (DISCORD_ALERTS_CHANNEL_ID, sinon le salon
 * de l'équipe DISCORD_STAFF_CHANNEL_ID), sans données personnelles et sans spam
 * (une alerte par erreur toutes les 15 min, 20 par heure au plus).
 */

const decide = createAlertThrottle({ repeatMs: 15 * 60_000, maxPerHour: 20 });
const channelId = config.discord.alertsChannelId || config.discord.staffChannelId;

export interface ErrorContext {
  /** Route, page ou tâche concernée (« GET /cod/matches/:id », « /cod/ranked »…). */
  where?: string;
  /** Pile d'appels, si disponible (seules les premières lignes sont gardées). */
  stack?: string;
  /** Navigateur, pour les erreurs du site (« Chrome · Android »). */
  browser?: string;
}

/** Message et pile lisibles à partir de n'importe quelle valeur levée. */
export function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: `${error.name}: ${error.message}`, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error).slice(0, 300) };
  } catch {
    return { message: String(error) };
  }
}

/** Supprime les blocs de code Discord d'un texte reçu (il est affiché dans un bloc). */
const safe = (text: string, max: number) => text.slice(0, max).replace(/`{3}/g, "'''");

/** Signale une erreur : toujours dans les journaux, dans Discord si le filtre anti-spam l'autorise. */
export function reportError(source: 'serveur' | 'site', message: string, context: ErrorContext = {}): void {
  console.error(`[erreur ${source}] ${context.where ?? ''} ${message}`, source === 'serveur' ? context.stack ?? '' : '');
  if (!discordEnabled || !channelId) return;

  const decision = decide(signatureOf(source, message, context.where), Date.now());
  if (!decision.send) return;

  const stack = (context.stack ?? '')
    .split('\n')
    .slice(1, 5)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  const header = [
    `🚨 **Erreur ${source}**`,
    context.where ? `\`${context.where.slice(0, 120).replace(/`/g, "'")}\`` : '',
    context.browser ? context.browser.slice(0, 60) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [
    header,
    '```',
    safe(message, 500),
    ...(stack ? [safe(stack, 700)] : []),
    '```',
    ...(decision.suppressed > 0 ? [`_(${decision.suppressed} autre(s) occurrence(s) depuis la dernière alerte)_`] : []),
  ];
  void discord(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: { content: lines.join('\n').slice(0, 1900), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS },
  }).catch((error: unknown) => console.warn('[alertes] envoi impossible', (error as Error).message));
}
