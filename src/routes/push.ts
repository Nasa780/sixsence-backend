import { Router } from 'express';
import { currentUser, requireAuth } from '../auth.js';
import { HttpError, asyncHandler } from '../errors.js';
import { getPrefs, setPrefs } from '../services/notificationPrefs.js';
import { pushPublicKey, subscribe, unsubscribe } from '../services/push.js';

/**
 * Notifications push.
 *
 *   GET  /push/key            clé publique VAPID (pour l'abonnement du navigateur)
 *   POST /push/subscribe      { subscription }  enregistrer cet appareil (connexion requise)
 *   POST /push/unsubscribe    { endpoint }      oublier cet appareil (connexion requise)
 *   GET  /push/preferences    catégories reçues en notification et en message privé Discord (connexion requise)
 *   POST /push/preferences    { push?: { catégorie: booléen }, dm?: { … } }  les modifier (connexion requise)
 */
export function pushRouter(): Router {
  const router = Router();

  router.get(
    '/key',
    asyncHandler(async (_req, res) => {
      const key = await pushPublicKey();
      if (!key) throw new HttpError(503, 'PUSH_UNAVAILABLE', 'Notifications indisponibles pour le moment.');
      res.json({ key });
    }),
  );

  router.post(
    '/subscribe',
    requireAuth,
    asyncHandler(async (req, res) => {
      await subscribe(currentUser(res).id, req.body);
      res.status(201).json({ subscribed: true });
    }),
  );

  router.post(
    '/unsubscribe',
    requireAuth,
    asyncHandler(async (req, res) => {
      await unsubscribe(currentUser(res).id, req.body);
      res.json({ subscribed: false });
    }),
  );

  router.get(
    '/preferences',
    requireAuth,
    asyncHandler(async (_req, res) => {
      res.json(await getPrefs(currentUser(res).id));
    }),
  );

  router.post(
    '/preferences',
    requireAuth,
    asyncHandler(async (req, res) => {
      res.json(await setPrefs(currentUser(res).id, req.body));
    }),
  );

  return router;
}
