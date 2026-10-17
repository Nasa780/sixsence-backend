import { Router } from 'express';
import { currentUser, requireAuth } from '../auth.js';
import { asyncHandler, uuidParam } from '../errors.js';
import { TEAM_REPORT_REASONS } from '../services/teamPolicy.js';
import {
  answerInvite,
  cancelInvite,
  createTeam,
  disbandTeam,
  getTeam,
  invitePlayer,
  kickMember,
  leaveTeam,
  listTeams,
  myTeamState,
  reportTeam,
  requestToJoin,
  searchInvitable,
  transferCrown,
  updateMember,
  updateTeam,
} from '../services/teams.js';

/**
 * Équipes du mode « Match team ».
 *
 * Publics :
 *   GET    /teams                              classement des équipes actives
 *   GET    /teams/report-reasons               motifs de signalement
 *   GET    /teams/:id                          fiche d'une équipe et son effectif
 *
 * Connexion Discord requise :
 *   GET    /teams/me                           ma page « Mon équipe » (équipe, invitations, conditions d'accès)
 *   POST   /teams                              créer une équipe        { name, tag, description?, color? }
 *   PATCH  /teams/:id                          modifier la fiche (Leader ; nom et tag : couronne) { …, logoUrl?, bannerUrl?, socials? }
 *   GET    /teams/:id/search?q=                joueurs à inviter (Leader)
 *   POST   /teams/:id/invites                  inviter un joueur (Leader)  { userId }
 *   POST   /teams/:id/requests                 candidater
 *   POST   /teams/invites/:inviteId/answer     accepter ou refuser     { accept }
 *   DELETE /teams/invites/:inviteId            annuler une invitation ou sa candidature
 *   PATCH  /teams/:id/members/:userId          { starter? (Leader), role? (couronne) }
 *   DELETE /teams/:id/members/:userId          exclure (Leader ; un Leader : couronne)
 *   POST   /teams/me/leave                     quitter son équipe (24 h avant d'en rejoindre une autre)
 *   POST   /teams/:id/transfer                 transmettre la couronne { userId }
 *   DELETE /teams/:id                          dissoudre (couronne)
 *   POST   /teams/:id/report                   signaler une équipe     { reason, details? }
 */
export function teamsRouter(): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => void res.json({ teams: await listTeams() })));
  router.get('/report-reasons', (_req, res) => void res.json(TEAM_REPORT_REASONS));
  router.get('/me', requireAuth, asyncHandler(async (_req, res) => void res.json(await myTeamState(currentUser(res).id))));
  router.post('/me/leave', requireAuth, asyncHandler(async (_req, res) => void res.json(await leaveTeam(currentUser(res).id))));
  router.post('/', requireAuth, asyncHandler(async (req, res) => void res.status(201).json(await createTeam(currentUser(res).id, req.body))));

  router.post('/invites/:inviteId/answer', requireAuth, asyncHandler(async (req, res) => void res.json(await answerInvite(currentUser(res).id, req.params.inviteId, req.body))));
  router.delete('/invites/:inviteId', requireAuth, asyncHandler(async (req, res) => void res.json(await cancelInvite(currentUser(res).id, req.params.inviteId))));

  router.get('/:id', asyncHandler(async (req, res) => void res.json(await getTeam(uuidParam(req, 'id')))));
  router.patch('/:id', requireAuth, asyncHandler(async (req, res) => void res.json(await updateTeam(currentUser(res).id, uuidParam(req, 'id'), req.body))));
  router.delete('/:id', requireAuth, asyncHandler(async (req, res) => void res.json(await disbandTeam(currentUser(res).id, uuidParam(req, 'id')))));
  router.get('/:id/search', requireAuth, asyncHandler(async (req, res) => void res.json(await searchInvitable(currentUser(res).id, uuidParam(req, 'id'), req.query.q))));
  router.post('/:id/invites', requireAuth, asyncHandler(async (req, res) => void res.json(await invitePlayer(currentUser(res).id, uuidParam(req, 'id'), req.body))));
  router.post('/:id/requests', requireAuth, asyncHandler(async (req, res) => void res.json(await requestToJoin(currentUser(res).id, uuidParam(req, 'id')))));
  router.patch(
    '/:id/members/:userId',
    requireAuth,
    asyncHandler(async (req, res) => void res.json(await updateMember(currentUser(res).id, uuidParam(req, 'id'), uuidParam(req, 'userId'), req.body))),
  );
  router.delete(
    '/:id/members/:userId',
    requireAuth,
    asyncHandler(async (req, res) => void res.json(await kickMember(currentUser(res).id, uuidParam(req, 'id'), uuidParam(req, 'userId')))),
  );
  router.post('/:id/transfer', requireAuth, asyncHandler(async (req, res) => void res.json(await transferCrown(currentUser(res).id, uuidParam(req, 'id'), req.body))));
  router.post('/:id/report', requireAuth, asyncHandler(async (req, res) => void res.json(await reportTeam(currentUser(res).id, uuidParam(req, 'id'), req.body))));

  return router;
}
