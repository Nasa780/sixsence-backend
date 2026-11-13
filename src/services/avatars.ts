import { supabase } from '../supabase.js';
import { avatarChanged, discordAvatarUrl } from './avatarPolicy.js';
import { discord } from './discord.js';

/**
 * Avatars Discord à jour sur le site. `users.avatar_url` n'est recopié qu'à la connexion Discord (déclencheur de
 * 0001_init.sql) : un joueur resté connecté garderait son ancien avatar. Deux rattrapages :
 * - tout de suite, quand un membre du serveur change d'avatar (GUILD_MEMBER_UPDATE reçu par le Gateway) ;
 * - toutes les 6 heures, chaque joueur inscrit relu par le bot (aussi ceux qui ne sont pas sur le serveur).
 * Seuls les avatars changés sont réécrits ; le pseudo n'est pas touché.
 */

/** Recopie l'avatar d'un compte Discord s'il a changé. Renvoie true si le site a été mis à jour. */
export async function applyDiscordAvatar(discordId: string, hash: string | null | undefined): Promise<boolean> {
  const fresh = discordAvatarUrl(discordId, hash);
  const { data } = await supabase.from('users').select('id, avatar_url').eq('discord_id', discordId).maybeSingle();
  const row = data as { id: string; avatar_url: string | null } | null;
  if (!row || !avatarChanged(row.avatar_url, fresh)) return false;
  const { error } = await supabase.from('users').update({ avatar_url: fresh }).eq('id', row.id);
  if (error) throw new Error(error.message);
  return true;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Relit l'avatar de tous les joueurs inscrits (un appel par joueur, espacés) et recopie ceux qui ont changé. */
export async function refreshAllAvatars(): Promise<number> {
  const { data, error } = await supabase.from('users').select('id, discord_id, avatar_url').not('discord_id', 'is', null);
  if (error) throw new Error(error.message);
  let updated = 0;
  for (const user of (data ?? []) as { id: string; discord_id: string; avatar_url: string | null }[]) {
    try {
      const account = (await discord(`/users/${user.discord_id}`)) as { avatar?: string | null } | null;
      if (!account) continue;
      const fresh = discordAvatarUrl(user.discord_id, account.avatar);
      if (avatarChanged(user.avatar_url, fresh)) {
        const { error: updateError } = await supabase.from('users').update({ avatar_url: fresh }).eq('id', user.id);
        if (!updateError) updated += 1;
      }
    } catch (caught) {
      console.warn('[avatars]', (caught as Error).message);
    }
    // Bien sous la limite de l'API Discord.
    await wait(250);
  }
  return updated;
}
