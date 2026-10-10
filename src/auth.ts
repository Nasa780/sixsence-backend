import type { RequestHandler, Response } from 'express';
import { HttpError } from './errors.js';
import { supabase } from './supabase.js';

export interface AuthUser {
  id: string;
}

/**
 * Petit cache mémoire : évite un aller-retour vers Supabase à chaque requête
 * d'un même joueur. Volontairement court pour qu'une déconnexion soit vite prise en compte.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5_000;
const cache = new Map<string, { user: AuthUser; expiresAt: number }>();

/**
 * Vérifie un jeton d'accès et renvoie le joueur, ou null s'il est invalide.
 *
 * Le jeton est celui de la session Supabase du joueur (connexion Discord).
 * On exige en plus que le compte provienne bien du fournisseur "discord".
 */
export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  if (!token || token.length > 4096) return null;

  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  const metadata = data.user.app_metadata ?? {};
  const providers: unknown[] = Array.isArray(metadata.providers) ? metadata.providers : [metadata.provider];
  if (!providers.includes('discord')) return null;

  const user: AuthUser = { id: data.user.id };
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(token, { user, expiresAt: Date.now() + CACHE_TTL_MS });
  return user;
}

/** Middleware : exige un en-tête "Authorization: Bearer <jeton>" valide. */
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  verifyAccessToken(token)
    .then((user) => {
      if (!user) {
        next(new HttpError(401, 'UNAUTHORIZED', 'Connexion Discord requise.'));
        return;
      }
      res.locals.user = user;
      next();
    })
    .catch(next);
};

/** Middleware : exige en plus le rôle admin (table users). À placer après requireAuth. */
export const requireAdmin: RequestHandler = (_req, res, next) => {
  isAdmin(currentUser(res).id)
    .then((admin) => {
      if (!admin) {
        next(new HttpError(403, 'FORBIDDEN', 'Action réservée aux administrateurs.'));
        return;
      }
      next();
    })
    .catch(next);
};

async function isAdmin(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  return !error && data?.role === 'admin';
}

/** Joueur authentifié de la requête en cours (posé par requireAuth). */
export function currentUser(res: Response): AuthUser {
  const user = res.locals.user as AuthUser | undefined;
  if (!user) throw new HttpError(401, 'UNAUTHORIZED', 'Connexion Discord requise.');
  return user;
}
