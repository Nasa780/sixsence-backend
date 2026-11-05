import { config } from '../config.js';
import { discord } from './discord.js';
import { moderationLine, type AuditEntry } from './discordModerationPolicy.js';
import { logToDiscord } from './siteLog.js';

/**
 * Journal de modération (salon du journal privé) : expulsions, bannissements, exclusions temporaires et messages
 * supprimés par la modération, reçus par la connexion Gateway. Exige le droit « Voir les logs du serveur ».
 */

let accessChecked = false;

/** Vérifié une fois par démarrage : sans ce droit, Discord n'envoie rien et le journal resterait muet sans explication. */
export async function checkAuditAccess(): Promise<void> {
  if (accessChecked) return;
  accessChecked = true;
  await discord(`/guilds/${config.discord.guildId}/audit-logs?limit=1`).catch(() => {
    logToDiscord('⚠️ Journal de modération à l’arrêt : donne au bot le droit « Voir les logs du serveur ».');
  });
}

export function onAuditEntry(entry: AuditEntry, botId: string | null): void {
  const line = moderationLine(entry, botId);
  if (line) logToDiscord(line);
}
