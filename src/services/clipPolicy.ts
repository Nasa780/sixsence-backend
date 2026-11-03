/**
 * Règles des clips (testées) : plateformes acceptées et lecture du lien, titre, limites d'ajout.
 * Le site construit le lecteur intégré d'après { provider, videoId }.
 */
export type ClipProvider = 'youtube' | 'twitch' | 'medal' | 'tiktok';

/** Clips ajoutés au plus en 24 h, et visibles au plus par joueur. */
export const CLIPS_PER_DAY = 5;
export const CLIPS_MAX = 60;
export const TITLE_MAX = 80;

const PATTERNS: [ClipProvider, RegExp][] = [
  ['youtube', /^(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)([\w-]{11})/i],
  ['youtube', /^youtu\.be\/([\w-]{11})/i],
  ['twitch', /^clips\.twitch\.tv\/([\w-]+)/i],
  ['twitch', /^(?:www\.|m\.)?twitch\.tv\/[\w]+\/clip\/([\w-]+)/i],
  ['medal', /^(?:www\.)?medal\.tv\/(?:[a-z]{2}\/)?(?:games\/[\w-]+\/)?clips?\/([\w-]+)/i],
  ['tiktok', /^(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/video\/(\d+)/i],
];

/** Plateforme et identifiant de la vidéo d'un lien, ou null s'il n'est pas reconnu. */
export function parseClipUrl(raw: string): { provider: ClipProvider; videoId: string; url: string } | null {
  const url = raw.trim();
  if (url.length > 300) return null;
  const match = /^https?:\/\/(.+)$/i.exec(url);
  if (!match) return null;
  for (const [provider, pattern] of PATTERNS) {
    const found = pattern.exec(match[1]!);
    if (found) return { provider, videoId: found[1]!, url };
  }
  return null;
}

/** Titre nettoyé (espaces), ou null s'il est vide ou trop long. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw.replace(/\s+/g, ' ').trim();
  return title.length >= 1 && title.length <= TITLE_MAX ? title : null;
}
