/**
 * Journal de modération : transforme une entrée du journal d'audit Discord en une ligne lisible, sans accès au réseau
 * (testé dans discordModerationPolicy.test.ts). Les actions du bot lui-même sont ignorées. Le texte des messages
 * supprimés n'est jamais connu : le bot ne lit pas les messages du serveur.
 */

const AUDIT = { Kick: 20, Ban: 22, Unban: 23, MemberUpdate: 24, MessageDelete: 72, MessageBulkDelete: 73 } as const;

export interface AuditEntry {
  guild_id?: string;
  action_type: number;
  user_id?: string | null;
  target_id?: string | null;
  reason?: string;
  options?: { channel_id?: string; count?: string };
  changes?: { key: string; new_value?: unknown; old_value?: unknown }[];
}

const cleanReason = (reason?: string) => (reason ?? '').replace(/[`*_~|>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Ligne du journal, ou null pour une action qui n'y a pas sa place. */
export function moderationLine(entry: AuditEntry, botId: string | null): string | null {
  const { action_type: action, user_id: userId, target_id: targetId, options } = entry;
  if (!userId || userId === botId) return null;
  const who = `<@${userId}>`;
  const target = `<@${targetId}>`;
  const reason = cleanReason(entry.reason);
  const end = reason ? ` · Motif : ${reason}` : '';
  const count = Number(options?.count) || 1;
  const messages = `${count} message${count > 1 ? 's' : ''}`;

  switch (action) {
    case AUDIT.Kick:
      return `👢 ${who} a expulsé ${target}${end}`;
    case AUDIT.Ban:
      return `🔨 ${who} a banni ${target}${end}`;
    case AUDIT.Unban:
      return `♻️ ${who} a levé le bannissement de ${target}${end}`;
    case AUDIT.MemberUpdate: {
      const change = entry.changes?.find((item) => item.key === 'communication_disabled_until');
      if (!change) return null;
      if (!change.new_value) return `✅ ${who} a levé l’exclusion temporaire de ${target}${end}`;
      const until = Math.floor(new Date(String(change.new_value)).getTime() / 1000);
      return `⏳ ${who} a exclu temporairement ${target} jusqu’au <t:${until}:f>${end}`;
    }
    case AUDIT.MessageDelete:
      return `🗑️ ${who} a supprimé ${messages} de ${target} dans <#${options?.channel_id}>`;
    case AUDIT.MessageBulkDelete:
      return `🗑️ ${who} a supprimé ${messages} dans <#${targetId}>`;
    default:
      return null;
  }
}
