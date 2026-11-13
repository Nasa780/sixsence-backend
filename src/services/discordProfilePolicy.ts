/**
 * Pseudo et avatar Discord d'un joueur, calculés comme à la connexion (déclencheur `handle_auth_user_sync` de
 * 0001_init.sql, qui recopie dans `users` ce que Supabase reçoit de Discord).
 */

/** Ce que Discord renvoie d'un compte (API REST `GET /users/:id` ou `user` d'un événement du Gateway). */
export interface DiscordAccount {
  id: string;
  username?: string | null;
  global_name?: string | null;
  avatar?: string | null;
}

/** Pseudo affiché : nom d'affichage Discord, sinon nom d'utilisateur, 40 caractères au plus, « Joueur » à défaut. */
export function discordDisplayName(account: Pick<DiscordAccount, 'username' | 'global_name'>): string {
  const name = account.global_name?.trim() || account.username?.trim() || 'Joueur';
  return [...name].slice(0, 40).join('');
}

/**
 * Adresse de l'avatar, au même format que Supabase : avatar animé (« a_… ») en .gif, sinon .png ; sans avatar
 * personnalisé, l'avatar par défaut de Discord (calculé depuis l'identifiant, comptes au pseudo unique).
 */
export function discordAvatarUrl(discordId: string, hash: string | null | undefined): string {
  if (hash) return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}`;
  let index = 0;
  try {
    index = Number((BigInt(discordId) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/**
 * Champs à réécrire dans `users` : seulement ceux qui ont changé (rien si tout est à jour). Le pseudo n'est réécrit que
 * si Discord en donne un (événement incomplet : pseudo laissé tel quel).
 */
export function profileChanges(stored: { username: string | null; avatar_url: string | null }, account: DiscordAccount): { username?: string; avatar_url?: string } {
  const changes: { username?: string; avatar_url?: string } = {};
  if (account.global_name !== undefined || account.username !== undefined) {
    const username = discordDisplayName(account);
    if (username !== (stored.username ?? '')) changes.username = username;
  }
  if (account.avatar !== undefined) {
    const avatar = discordAvatarUrl(account.id, account.avatar);
    if (avatar !== (stored.avatar_url ?? '')) changes.avatar_url = avatar;
  }
  return changes;
}
