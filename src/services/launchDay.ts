import { verifyAccessToken } from '../auth.js';
import { supabase } from '../supabase.js';
import { syncCards } from './cards.js';
import { inLaunchDay, withLaunchBadge } from './launchDayPolicy.js';

/**
 * Jour 1 de GTA 6 : badge `gta6-jour1` (et carte de visite « Jour 1 · Vice City ») aux joueurs connectés au site
 * pendant les 48 h qui suivent la sortie. Repéré sur le signal de présence (`POST /presence`, envoyé toutes les 45 s
 * par chaque onglet ouvert, avec le jeton du joueur s'il est connecté) : le jeton n'est vérifié que pendant ces 48 h,
 * et une seule fois par joueur (mémoire), puis la carte est attribuée par syncCards (notification habituelle).
 */

const done = new Set<string>();
const pending = new Set<string>();

async function grant(userId: string): Promise<void> {
  const { data, error } = await supabase.from('cod_profiles').select('badges').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return;
  const next = withLaunchBadge((data as { badges: string[] | null }).badges);
  if (next) {
    const { error: updateError } = await supabase.from('cod_profiles').update({ badges: next }).eq('user_id', userId);
    if (updateError) throw new Error(updateError.message);
  }
  done.add(userId);
  await syncCards(userId);
}

/** Signal de présence : pendant le jour 1, donne le badge au joueur connecté (sans jamais bloquer la réponse). */
export function noteLaunchDayVisit(authorization: string | undefined): void {
  if (!inLaunchDay(Date.now())) return;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return;
  void verifyAccessToken(token)
    .then(async (user) => {
      if (!user || done.has(user.id) || pending.has(user.id)) return;
      pending.add(user.id);
      try {
        await grant(user.id);
      } finally {
        pending.delete(user.id);
      }
    })
    .catch((error) => console.warn('[jour 1 GTA 6]', (error as Error).message));
}
