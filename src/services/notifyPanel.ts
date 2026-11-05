import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { supabase } from '../supabase.js';
import { createOnboardingRoles, notifyRoleId } from './announcements.js';
import { discord, discordEnabled } from './discord.js';
import { notifyPanelMessage, notifyReply, type NotifyChoice } from './discordNotifyPolicy.js';

/** Panneau « Choisis tes notifications », publié depuis l'admin dans DISCORD_NOTIFY_CHANNEL_ID (un seul message). */

const PANEL_KEY = 'discord_notify_panel';
const EPHEMERAL = 1 << 6;

/** Publie le panneau, ou met à jour celui déjà publié (pas de doublon). */
export async function publishNotifyPanel(): Promise<{ action: 'posted' | 'updated' }> {
  const channelId = config.discord.notifyChannelId;
  if (!discordEnabled || !channelId) throw new HttpError(409, 'DISCORD_DISABLED', 'Le bot Discord ou le salon des notifications (DISCORD_NOTIFY_CHANNEL_ID) n’est pas configuré.');
  await createOnboardingRoles();
  const { data } = await supabase.from('app_state').select('value').eq('key', PANEL_KEY).maybeSingle();
  const [savedChannel, savedMessage] = ((data as { value?: string } | null)?.value ?? '').split(':');
  try {
    if (savedChannel === channelId && savedMessage) {
      try {
        await discord(`/channels/${channelId}/messages/${savedMessage}`, { method: 'PATCH', body: notifyPanelMessage() });
        return { action: 'updated' };
      } catch {
        // Message supprimé : on en publie un nouveau.
      }
    }
    const posted = (await discord(`/channels/${channelId}/messages`, { method: 'POST', body: notifyPanelMessage() })) as { id: string };
    await supabase.from('app_state').upsert({ key: PANEL_KEY, value: `${channelId}:${posted.id}` });
    return { action: 'posted' };
  } catch (caught) {
    throw new HttpError(502, 'DISCORD_ERROR', `Publication impossible : vérifie que le bot peut écrire dans le salon (${(caught as Error).message}).`);
  }
}

export interface NotifyInteraction {
  token: string;
  application_id: string;
  member?: { user?: { id?: string }; roles?: string[] };
}

/** Ajoute ou retire le rôle du membre selon ce qu'il a déjà. Renvoie le texte de la réponse. */
async function toggle(choice: NotifyChoice, interaction: NotifyInteraction): Promise<string> {
  const userId = interaction.member?.user?.id;
  if (!userId) return 'Ce bouton fonctionne uniquement sur le serveur.';
  const roleId = await notifyRoleId(choice.type);
  if (!roleId) return 'Cette notification n’est pas disponible pour le moment.';
  const added = !interaction.member?.roles?.includes(roleId);
  await discord(`/guilds/${config.discord.guildId}/members/${userId}/roles/${roleId}`, { method: added ? 'PUT' : 'DELETE' });
  return notifyReply(choice, added);
}

/** Clic sur un bouton du panneau : réponse visible du seul membre, envoyée une fois le rôle changé. */
export function handleNotifyInteraction(choice: NotifyChoice, interaction: NotifyInteraction): { type: number; data: { flags: number } } {
  void (async () => {
    let content: string;
    try {
      content = await toggle(choice, interaction);
    } catch (caught) {
      console.warn('[discord] notification impossible', (caught as Error).message);
      content = 'Oups, impossible de changer cette notification. Réessaie dans un instant.';
    }
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    }).catch((caught) => console.warn('[discord] réponse impossible', (caught as Error).message));
  })();
  return { type: 5, data: { flags: EPHEMERAL } };
}
