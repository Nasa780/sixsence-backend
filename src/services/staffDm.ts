import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { supabase } from '../supabase.js';
import { discord, discordEnabled, discordIds } from './discord.js';
import { logToDiscord } from './siteLog.js';

/**
 * Message privé d'un admin à un joueur, envoyé par le bot SixSence (POST /admin/players/:id/message) : encadré
 * « Message de l'équipe SixSence » signé de l'équipe (pas du nom de l'admin), avec un lien vers le site. Trace dans
 * le salon des journaux (admin, joueur, texte). Le joueur ne peut pas répondre au bot : il passe par un ticket.
 */

export const STAFF_DM_MAX = 1500;

export async function sendStaffDm(adminId: string, targetId: string, input: unknown): Promise<{ sent: true }> {
  const text = typeof input === 'object' && input ? String((input as { text?: unknown }).text ?? '').trim() : '';
  if (text.length < 1 || text.length > STAFF_DM_MAX) {
    throw new HttpError(400, 'INVALID_MESSAGE', `Le message doit contenir entre 1 et ${STAFF_DM_MAX} caractères.`);
  }
  if (!discordEnabled) throw new HttpError(503, 'DISCORD_DISABLED', 'Le bot Discord est désactivé.');

  const discordId = (await discordIds([targetId])).get(targetId);
  if (!discordId) throw new HttpError(409, 'NO_DISCORD', "Ce joueur n'a pas de compte Discord lié.");

  try {
    const channel = (await discord('/users/@me/channels', { method: 'POST', body: { recipient_id: discordId } })) as { id: string };
    await discord(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: {
        embeds: [
          {
            title: "✉️ Message de l'équipe SixSence",
            description: text,
            color: 0xd4af37,
            footer: { text: 'Pour répondre, ouvre un ticket sur le serveur Discord SixSence.' },
            timestamp: new Date().toISOString(),
          },
        ],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Ouvrir SixSence', url: config.siteUrl }] }],
      },
    });
  } catch (error) {
    console.warn('[message équipe] envoi impossible', (error as Error).message);
    // 50007 : le joueur bloque les messages privés du serveur (ou a quitté le serveur).
    throw new HttpError(409, 'DM_FAILED', "Message non remis : le joueur bloque les messages privés ou n'est plus sur le serveur.");
  }

  const { data } = await supabase.from('users').select('id, username').in('id', [adminId, targetId]);
  const names = new Map(((data ?? []) as { id: string; username: string }[]).map((row) => [row.id, row.username]));
  logToDiscord(`✉️ **${names.get(adminId) ?? 'Un admin'}** a envoyé un message privé à **${names.get(targetId) ?? 'un joueur'}** :\n> ${text.replace(/\n/g, '\n> ')}`);
  return { sent: true };
}
