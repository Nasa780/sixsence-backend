import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { discord, discordEnabled } from './discord.js';
import { liveClaimDay, liveMessage, type LiveStream } from './twitchPolicy.js';

/**
 * Annonce sur Discord d'un joueur qui lance un direct sur un jeu de SixSence (DISCORD_LIVE_CHANNEL_ID), sans mention
 * de rôle. Une seule annonce par chaîne et par jour : une coupure ou un redémarrage du serveur ne la répète pas.
 */
export async function announceNewStreams(streams: LiveStream[]): Promise<void> {
  const channelId = config.discord.liveChannelId;
  if (!discordEnabled || !channelId) return;
  for (const stream of streams) {
    const { data: claimed, error } = await supabase.rpc('app_claim', { p_key: `live_announce:${stream.channel.toLowerCase()}`, p_value: liveClaimDay(stream) });
    if (error) throw new Error(error.message);
    if (claimed) await discord(`/channels/${channelId}/messages`, { method: 'POST', body: liveMessage(stream) });
  }
}
