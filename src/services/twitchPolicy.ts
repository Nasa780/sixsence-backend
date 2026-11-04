/**
 * Règles du « En direct sur Twitch », sans accès au réseau ni à la base (testées dans twitchPolicy.test.ts).
 * Seuls les jeux de SixSence sont affichés : un joueur en direct sur un autre jeu ne remonte pas sur le site.
 */
export const GAME_PATTERN = /call of duty|grand theft auto/i;
/** La recherche Helix accepte 100 chaînes par appel. */
export const CHANNELS_PER_CALL = 100;

/** Une chaîne en direct, telle que renvoyée par l'API Twitch (GET /helix/streams). */
export interface HelixStream {
  user_login: string;
  title?: string;
  game_name?: string;
  type?: string;
  viewer_count?: number;
  started_at?: string;
  thumbnail_url?: string;
}

export interface LivePlayer {
  id: string;
  username: string;
  avatarUrl: string | null;
  twitch: string;
}

export interface LiveStream {
  channel: string;
  title: string;
  game: string;
  viewers: number;
  startedAt: string | null;
  thumbnail: string | null;
  player: { id: string; username: string; avatarUrl: string | null };
}

/** Miniature renvoyée par Twitch, seulement si elle vient bien de ses serveurs d'images. */
export function safeThumbnail(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return /^https:\/\/[\w.-]+\.(twitch\.tv|jtvnw\.net)\//i.test(url) ? url : null;
}

/** Découpe la liste des chaînes en paquets (doublons et casse retirés). */
export function chunkChannels(channels: string[]): string[][] {
  const unique = [...new Set(channels.map((channel) => channel.toLowerCase()))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHANNELS_PER_CALL) chunks.push(unique.slice(i, i + CHANNELS_PER_CALL));
  return chunks;
}

/** Garde les directs des joueurs sur un jeu de SixSence, les plus regardés d'abord. */
export function pickStreams(streams: HelixStream[], players: LivePlayer[]): LiveStream[] {
  const byChannel = new Map(players.map((player) => [player.twitch.toLowerCase(), player]));
  const picked: LiveStream[] = [];
  for (const stream of streams) {
    const player = byChannel.get(stream.user_login.toLowerCase());
    if (!player || (stream.type && stream.type !== 'live') || !GAME_PATTERN.test(stream.game_name ?? '')) continue;
    picked.push({
      channel: stream.user_login,
      title: (stream.title ?? '').trim().slice(0, 140),
      game: stream.game_name ?? '',
      viewers: stream.viewer_count ?? 0,
      startedAt: stream.started_at ?? null,
      thumbnail: stream.thumbnail_url ? stream.thumbnail_url.replace('{width}', '640').replace('{height}', '360') : null,
      player: { id: player.id, username: player.username, avatarUrl: player.avatarUrl },
    });
  }
  return picked.sort((a, b) => b.viewers - a.viewers);
}
