import type { RequestHandler } from 'express';

/**
 * Limiteur de débit minimal, en mémoire : au plus `limit` requêtes par fenêtre
 * de `windowMs` et par adresse IP. Suffisant pour une seule instance Render ;
 * au-delà, il faudrait un stockage partagé (Redis).
 */
export function rateLimit(limit: number, windowMs: number): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Purge régulière des entrées expirées ; unref() n'empêche pas le processus de s'arrêter.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip ?? 'inconnu';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > limit) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Trop de requêtes. Patiente un instant.' } });
      return;
    }
    next();
  };
}
