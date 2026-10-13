import { Router } from 'express';
import { rateLimit } from '../rateLimit.js';
import { isNoise } from '../services/alertPolicy.js';
import { reportError } from '../services/alerts.js';

/**
 * Erreurs remontées par le site (navigateur des joueurs) :
 *   POST /errors   { message, stack?, page?, browser? }
 *
 * Public, sans données personnelles : seule la page (sans paramètres) et le type de
 * navigateur sont transmis. Limité à 10 envois par minute et par adresse.
 */
export function errorsRouter(): Router {
  const router = Router();

  router.post('/', rateLimit(10, 60_000), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
    const message = text(body.message, 500).trim();

    if (message && !isNoise(message)) {
      reportError('site', message, {
        where: text(body.page, 120).split('?')[0] || undefined,
        stack: text(body.stack, 2000) || undefined,
        browser: text(body.browser, 60) || undefined,
      });
    }
    res.status(204).end();
  });

  return router;
}
