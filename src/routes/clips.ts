import { Router } from 'express';
import { currentUser, optionalAuth, requireAuth, roleOf, viewerOf } from '../auth.js';
import { asyncHandler, uuidParam } from '../errors.js';
import { clipOfWeek, createClip, listClips, recentMatchesFor, removeClip, reportClip, toggleVote } from '../services/clips.js';

/**
 * Clips des joueurs (services/clips.ts).
 *
 * Publics (jeton facultatif : vote du visiteur) :
 *   GET    /clips                  liste (?sort=recent|top, ?mode=classe|division|tournoi, ?user=, ?before=)
 *   GET    /clips/week             clip de la semaine (ou null)
 *
 * Connexion Discord requise :
 *   GET    /clips/matches          matchs récents du joueur, à rattacher
 *   POST   /clips                  { url, title, match?: { kind, id } }
 *   POST   /clips/:id/vote         ajoute ou retire son vote « 🔥 »
 *   POST   /clips/:id/report       { reason? } signalement au salon staff
 *   DELETE /clips/:id              retrait (auteur, admin, staff)
 */
export function clipsRouter(): Router {
  const router = Router();

  router.get('/', optionalAuth, asyncHandler(async (req, res) => void res.json(await listClips(req.query as Record<string, unknown>, viewerOf(res)?.id ?? null))));
  router.get('/week', asyncHandler(async (_req, res) => void res.json({ clip: await clipOfWeek() })));
  router.get('/matches', requireAuth, asyncHandler(async (_req, res) => void res.json({ matches: await recentMatchesFor(currentUser(res).id) })));
  router.post('/', requireAuth, asyncHandler(async (req, res) => void res.status(201).json(await createClip(currentUser(res).id, req.body))));
  router.post('/:id/vote', requireAuth, asyncHandler(async (req, res) => void res.json(await toggleVote(currentUser(res).id, uuidParam(req, 'id')))));
  router.post('/:id/report', requireAuth, asyncHandler(async (req, res) => void res.json(await reportClip(currentUser(res).id, uuidParam(req, 'id'), req.body))));
  router.delete(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = currentUser(res);
      res.json(await removeClip(user.id, await roleOf(user.id), uuidParam(req, 'id')));
    }),
  );

  return router;
}
