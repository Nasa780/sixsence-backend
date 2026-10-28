import { config } from '../config.js';
import { HttpError } from '../errors.js';

/**
 * Affiches des coupes (migration 0055) : affiche envoyée par l'admin (bucket public cup-posters), sinon affiche
 * générée par le site (/api/og/affiche) avec le nom, la date et le format de la coupe.
 */

interface PosterSource {
  kind: string;
  name: string;
  starts_at?: string | null;
  size: number;
  best_of: number;
  final_best_of: number;
  bracket: string;
  team_size: number | null;
  poster_url?: string | null;
}

const posterPrefix = () => `${config.supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/cup-posters/`;

/** Date lisible de la coupe, heure de Paris : « dim. 1 nov. · 20:30 ». */
export function cupDate(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** Ligne de format : « 4v4 · BO3 · Élimination directe ». */
export function cupFormat(source: PosterSource): string {
  const size = source.kind === 'anubis' ? source.team_size : config.teams.rosterSize;
  return [size ? `${size}v${size}` : null, `BO${source.best_of}`, source.bracket === 'double' ? 'Double élimination' : 'Élimination directe'].filter(Boolean).join(' · ');
}

/** Adresse de l'affiche : celle envoyée par l'admin, sinon l'affiche générée par le site. */
export function posterOf(source: PosterSource): string {
  if (source.poster_url) return source.poster_url;
  const params = new URLSearchParams({ kind: source.kind, name: source.name.slice(0, 60), format: cupFormat(source) });
  if (source.starts_at) params.set('date', cupDate(source.starts_at));
  params.set('places', `${source.size} ${source.kind === 'anubis' ? 'équipes' : 'places'}`);
  return `${config.siteUrl}/api/og/affiche?${params.toString()}`;
}

/** Affiche envoyée par l'admin : une image du bucket cup-posters, ou null pour revenir à l'affiche générée. */
export function parsePosterUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !value.startsWith(posterPrefix()) || value.length > 500) {
    throw new HttpError(400, 'INVALID_POSTER', 'Affiche invalide : envoie une image depuis l’administration.');
  }
  return value;
}
