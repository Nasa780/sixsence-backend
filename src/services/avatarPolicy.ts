/**
 * Adresse de l'avatar Discord d'un joueur, au même format que celle recopiée à la connexion par Supabase
 * (`users.avatar_url`) : avatar animé (« a_… ») en .gif, sinon .png ; sans avatar personnalisé, l'avatar par défaut
 * de Discord (calculé depuis l'identifiant, comptes au pseudo unique).
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

/** Faut-il réécrire l'avatar enregistré ? Seulement s'il a changé (aucune écriture inutile). */
export function avatarChanged(stored: string | null | undefined, fresh: string): boolean {
  return (stored ?? '') !== fresh;
}
