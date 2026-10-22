import webpush from 'web-push';
import { config } from '../config.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';

/**
 * Notifications push (Web Push) : préviennent un joueur même quand le site est fermé,
 * en particulier sur téléphone avec l'appli installée (PWA).
 *
 * Clés VAPID : VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY si elles sont définies ; sinon le
 * serveur les génère au premier démarrage et les garde dans la table privée app_secrets
 * (rien à configurer). Un abonnement refusé par le navigateur (404 / 410) est supprimé.
 */

let ready: Promise<string | null> | null = null;

async function readOrCreateKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };

  const rows = (unwrap(await supabase.from('app_secrets').select('key, value').in('key', ['vapid_public', 'vapid_private'])) ?? []) as {
    key: string;
    value: string;
  }[];
  const publicKey = rows.find((row) => row.key === 'vapid_public')?.value;
  const privateKey = rows.find((row) => row.key === 'vapid_private')?.value;
  if (publicKey && privateKey) return { publicKey, privateKey };

  const keys = webpush.generateVAPIDKeys();
  // ignoreDuplicates : si deux démarrages se croisent, la première paire enregistrée gagne.
  await supabase.from('app_secrets').upsert(
    [
      { key: 'vapid_public', value: keys.publicKey },
      { key: 'vapid_private', value: keys.privateKey },
    ],
    { onConflict: 'key', ignoreDuplicates: true },
  );
  return readOrCreateKeys();
}

/** Prépare l'envoi ; renvoie la clé publique (donnée au navigateur), ou null si indisponible. */
export function pushPublicKey(): Promise<string | null> {
  if (!ready) {
    ready = readOrCreateKeys()
      .then(({ publicKey, privateKey }) => {
        webpush.setVapidDetails(config.siteUrl, publicKey, privateKey);
        return publicKey;
      })
      .catch((error) => {
        console.error('[push] clés VAPID indisponibles', error);
        ready = null;
        return null;
      });
  }
  return ready;
}

interface SubscriptionInput {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

export async function subscribe(userId: string, body: unknown): Promise<void> {
  const input = ((body ?? {}) as { subscription?: SubscriptionInput }).subscription ?? {};
  const endpoint = input.endpoint;
  const p256dh = input.keys?.p256dh;
  const auth = input.keys?.auth;
  if (
    typeof endpoint !== 'string' ||
    !/^https:\/\//.test(endpoint) ||
    endpoint.length > 1000 ||
    typeof p256dh !== 'string' ||
    p256dh.length > 200 ||
    typeof auth !== 'string' ||
    auth.length > 100
  ) {
    throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'Abonnement aux notifications invalide.');
  }
  // Un même appareil réabonné (ou repris par un autre compte) remplace l'ancien abonnement.
  unwrap(
    await supabase
      .from('push_subscriptions')
      .upsert({ user_id: userId, endpoint, p256dh, auth, created_at: new Date().toISOString() }, { onConflict: 'endpoint' }),
  );
  // Au plus 10 appareils par joueur : on garde les plus récents.
  const rows = (unwrap(
    await supabase.from('push_subscriptions').select('id').eq('user_id', userId).order('created_at', { ascending: false }),
  ) ?? []) as { id: number }[];
  const extra = rows.slice(10).map((row) => row.id);
  if (extra.length > 0) await supabase.from('push_subscriptions').delete().in('id', extra);
}

export async function unsubscribe(userId: string, body: unknown): Promise<void> {
  const endpoint = (body as { endpoint?: unknown } | undefined)?.endpoint;
  if (typeof endpoint !== 'string') return;
  await supabase.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint);
}

export interface PushMessage {
  title: string;
  body: string;
  /** Page ouverte au clic sur la notification. */
  url: string;
  /** Une nouvelle notification de même tag remplace la précédente. */
  tag?: string;
  /** Reste affichée jusqu'à ce que le joueur la touche (match trouvé). */
  urgent?: boolean;
  /** Match trouvé : bouton « Accepter » de la notification (adresse de l'API et jeton signé de ce joueur). */
  ready?: { url: string; token: string };
}

/** Envoie une notification à tous les appareils des joueurs donnés (au mieux, sans erreur). */
export async function pushToUsers(userIds: string[], message: PushMessage): Promise<void> {
  if (userIds.length === 0 || !(await pushPublicKey())) return;
  const { data } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth').in('user_id', userIds);
  const subscriptions = (data ?? []) as { id: number; endpoint: string; p256dh: string; auth: string }[];
  const payload = JSON.stringify(message);

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
          { TTL: message.urgent ? 60 : 3600, urgency: message.urgent ? 'high' : 'normal' },
        );
        await supabase.from('push_subscriptions').update({ last_used_at: new Date().toISOString() }).eq('id', subscription.id);
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', subscription.id);
        } else {
          console.warn('[push] envoi impossible', status ?? (error as Error).message);
        }
      }
    }),
  );
}
