import { supabase } from '../supabase.js';
import { discord } from './discord.js';
import { profileChanges, type DiscordAccount } from './discordProfilePolicy.js';

/**
 * Pseudo et avatar Discord à jour sur le site. `users.username` et `users.avatar_url` ne sont recopiés qu'à la
 * connexion Discord (déclencheur de 0001_init.sql) : un joueur resté connecté gardait son ancien pseudo et son ancien
 * avatar. Deux rattrapages :
 * - tout de suite, quand un membre du serveur change de pseudo ou d'avatar (GUILD_MEMBER_UPDATE reçu par le Gateway) ;
 * - toutes les 6 heures, chaque joueur inscrit relu par le bot (aussi ceux qui ne sont pas sur le serveur).
 * Seuls les champs changés sont réécrits (règles dans discordProfilePolicy.ts).
 */

type StoredUser = { id: string; discord_id: string; username: string | null; avatar_url: string | null };

async function save(user: StoredUser, account: DiscordAccount): Promise<boolean> {
  const changes = profileChanges(user, account);
  if (!Object.keys(changes).length) return false;
  const { error } = await supabase.from('users').update(changes).eq('id', user.id);
  if (error) throw new Error(error.message);
  return true;
}

/** Recopie le pseudo et l'avatar d'un compte Discord s'ils ont changé. Renvoie true si le site a été mis à jour. */
export async function applyDiscordProfile(account: DiscordAccount): Promise<boolean> {
  const { data } = await supabase.from('users').select('id, discord_id, username, avatar_url').eq('discord_id', account.id).maybeSingle();
  return data ? save(data as StoredUser, account) : false;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Relit le compte Discord de tous les joueurs inscrits (un appel par joueur, espacés) et recopie ce qui a changé. */
export async function refreshAllDiscordProfiles(): Promise<number> {
  const { data, error } = await supabase.from('users').select('id, discord_id, username, avatar_url').not('discord_id', 'is', null);
  if (error) throw new Error(error.message);
  let updated = 0;
  for (const user of (data ?? []) as StoredUser[]) {
    try {
      const account = (await discord(`/users/${user.discord_id}`)) as DiscordAccount | null;
      if (account && (await save(user, { ...account, id: user.discord_id }))) updated += 1;
    } catch (caught) {
      console.warn('[profils discord]', (caught as Error).message);
    }
    // Bien sous la limite de l'API Discord.
    await wait(250);
  }
  return updated;
}
