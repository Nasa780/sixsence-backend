import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { chunkChannels, pickStreams, safeThumbnail, type HelixStream, type LivePlayer, type LiveStream } from './twitchPolicy.js';

/**
 * « En direct sur Twitch » : toutes les 2 minutes, le serveur demande à Twitch lesquelles des chaînes liées aux
 * profils (`cod_profiles.twitch`) sont en direct ; le résultat reste en mémoire et part dans GET /live. Sans
 * TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET, rien n'est demandé et la liste reste vide : le site n'affiche rien.
 */

const STALE_MS = 10 * 60_000; // Twitch injoignable plus longtemps : on n'affiche plus de directs périmés
let streams: LiveStream[] = [];
let refreshedAt = 0;
let lastError: string | null = null;
let channelCount = 0;
let seen: { channel: string; game: string }[] = [];
let token: { value: string; expiresAt: number } | null = null;

export const twitchEnabled = Boolean(config.twitch.clientId && config.twitch.clientSecret);

/** Jeton d'application Twitch (identifiants du serveur), renouvelé une heure avant son expiration. */
async function appToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const body = new URLSearchParams({ client_id: config.twitch.clientId, client_secret: config.twitch.clientSecret, grant_type: 'client_credentials' });
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`jeton refusé (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 3600) * 1000 };
  return token.value;
}

/** Appel à l'API Twitch avec le jeton d'application. */
async function helix<T>(path: string): Promise<T[]> {
  const res = await fetch(`https://api.twitch.tv/helix/${path}`, {
    headers: { 'Client-Id': config.twitch.clientId, Authorization: `Bearer ${await appToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) token = null; // jeton révoqué : redemandé au prochain passage
  if (!res.ok) throw new Error(`recherche refusée (${res.status})`);
  return ((await res.json()) as { data: T[] }).data;
}

const fetchStreams = (channels: string[]) => helix<HelixStream>(`streams?first=100&${channels.map((channel) => `user_login=${encodeURIComponent(channel)}`).join('&')}`);

const THUMB_TTL = 24 * 60 * 60_000;
const thumbnails = new Map<string, { url: string | null; at: number }>();

/** Miniature d'un clip Twitch, gardée 24 h en mémoire (null si le clip est introuvable ou sans clés). */
export async function twitchClipThumbnail(clipId: string): Promise<string | null> {
  if (!twitchEnabled) return null;
  const known = thumbnails.get(clipId);
  if (known && Date.now() - known.at < THUMB_TTL) return known.url;
  const [clip] = await helix<{ thumbnail_url?: string }>(`clips?id=${encodeURIComponent(clipId)}`);
  const url = safeThumbnail(clip?.thumbnail_url);
  if (thumbnails.size >= 1000) thumbnails.clear();
  thumbnails.set(clipId, { url, at: Date.now() });
  return url;
}

/** Joueurs avec une chaîne liée, sans ceux exclus en ce moment. */
async function linkedPlayers(): Promise<LivePlayer[]> {
  const { data, error } = await supabase.from('cod_profiles').select('user_id, twitch, banned_until').not('twitch', 'is', null);
  if (error) throw error;
  const now = Date.now();
  const links = ((data ?? []) as { user_id: string; twitch: string; banned_until: string | null }[]).filter(
    (link) => !link.banned_until || new Date(link.banned_until).getTime() <= now,
  );
  if (links.length === 0) return [];
  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, username, avatar_url')
    .in('id', links.map((link) => link.user_id));
  if (usersError) throw usersError;
  const byId = new Map(((users ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((user) => [user.id, user]));
  return links.flatMap((link) => {
    const user = byId.get(link.user_id);
    return user ? [{ id: user.id, username: user.username, avatarUrl: user.avatar_url, twitch: link.twitch }] : [];
  });
}

/** Passage périodique (index.ts). Une erreur est journalisée : les directs connus restent jusqu'à STALE_MS. */
export async function sweepTwitch(): Promise<void> {
  if (!twitchEnabled) return;
  try {
    const players = await linkedPlayers();
    const found: HelixStream[] = [];
    for (const chunk of chunkChannels(players.map((player) => player.twitch))) found.push(...(await fetchStreams(chunk)));
    streams = pickStreams(found, players);
    refreshedAt = Date.now();
    channelCount = players.length;
    seen = found.map((stream) => ({ channel: stream.user_login, game: stream.game_name ?? '' }));
    lastError = null;
  } catch (error) {
    lastError = (error as Error).message;
    console.warn('[twitch]', lastError);
  }
}

/** État du suivi pour GET /health : jamais de clé, seulement ce que Twitch montre déjà publiquement. */
export function twitchStatus() {
  return { enabled: twitchEnabled, channels: channelCount, checkedAt: refreshedAt ? new Date(refreshedAt).toISOString() : null, error: lastError, seen, shown: streams.length };
}

/** Directs du moment, les plus regardés d'abord (vide si Twitch ne répond plus depuis 10 minutes). */
export function liveStreams(): LiveStream[] {
  return Date.now() - refreshedAt > STALE_MS ? [] : streams;
}
