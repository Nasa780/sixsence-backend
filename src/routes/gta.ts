import { Router } from 'express';
import { currentUser, requireAdmin, requireAuth } from '../auth.js';
import { asyncHandler, uuidParam } from '../errors.js';
import {
  createEvent,
  getEvent,
  listEvents,
  parseNewEvent,
  registerToEvent,
  unregisterFromEvent,
  type EventScope,
} from '../services/gtaEvents.js';

/**
 * Endpoints des événements GTA 6.
 *
 * Publics :
 *   GET    /gta/events                 liste (?scope=upcoming | past | all)
 *   GET    /gta/events/:id             détail
 *
 * Connexion Discord requise :
 *   POST   /gta/events/:id/register    s'inscrire
 *   DELETE /gta/events/:id/register    se désinscrire
 *   POST   /gta/events                 création (admin)
 */
export function gtaRouter(): Router {
  const router = Router();

  router.get(
    '/events',
    asyncHandler(async (req, res) => {
      const requested = req.query.scope;
      const scope: EventScope = requested === 'past' || requested === 'all' ? requested : 'upcoming';
      res.json({ events: await listEvents(scope) });
    }),
  );

  router.get(
    '/events/:id',
    asyncHandler(async (req, res) => {
      res.json({ event: await getEvent(uuidParam(req, 'id')) });
    }),
  );

  router.post(
    '/events',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req, res) => {
      const event = await createEvent(parseNewEvent(req.body), currentUser(res).id);
      res.status(201).json({ event });
    }),
  );

  router.post(
    '/events/:id/register',
    requireAuth,
    asyncHandler(async (req, res) => {
      const registeredCount = await registerToEvent(uuidParam(req, 'id'), currentUser(res).id);
      res.json({ registered: true, registered_count: registeredCount });
    }),
  );

  router.delete(
    '/events/:id/register',
    requireAuth,
    asyncHandler(async (req, res) => {
      await unregisterFromEvent(uuidParam(req, 'id'), currentUser(res).id);
      res.json({ registered: false });
    }),
  );

  return router;
}
