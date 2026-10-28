import { Router } from 'express';
import { currentUser, optionalAuth, requireAuth, viewerOf } from '../auth.js';
import { config } from '../config.js';
import { asyncHandler, uuidParam } from '../errors.js';
import {
  addTeamProof,
  answerTeamForfeit,
  claimTeamForfeit,
  confirmTeamScores,
  correctTeamMatch,
  markTeamPresent,
  playerTeamMatches,
  postTeamMessage,
  setTeamGameCode,
  stayInTeamQueue,
  getTeamMatch,
  joinTeamQueue,
  leaveTeamQueue,
  pickTeamMap3,
  reportTeamScores,
  resolveTeamMatch,
  teamMatchHistory,
  teamPlayState,
  teamStatus,
} from '../services/teamMatches.js';
import { TEAM_REPORT_REASONS } from '../services/teamPolicy.js';
import { getCircuit } from '../services/circuit.js';
import { cancelTeamSchedule, scheduleSlots, scheduleTeamMatch } from '../services/teamSchedules.js';
import { answerChallenge, cancelChallenge, createChallenge, myChallenges } from '../services/challenges.js';
import { leagueState } from '../services/leagues.js';
import { checkIn, currentTournament, getTournament, listCups, registerTeam, setSquadRoster, unregisterTeam } from '../services/tournaments.js';
import {
  answerInvite,
  inviteLinkPreview,
  joinByInviteLink,
  teamInviteLink,
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
 * Équipes du Division.
 *
 * Publics :
 *   GET    /teams                              classement des équipes actives
 *   GET    /teams/status                       compteurs (équipes en recherche, matchs en cours, équipes actives)
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
 *   GET    /teams/:id/invite-link              lien d'invitation de l'équipe (Leader) ; POST …/invite-link/reset : nouveau lien
 *   GET    /teams/join/:code                   aperçu public d'un lien d'invitation ; POST : rejoindre l'équipe
 *   POST   /teams/invites/:inviteId/answer     accepter ou refuser     { accept }
 *   DELETE /teams/invites/:inviteId            annuler une invitation ou sa candidature
 *   PATCH  /teams/:id/members/:userId          { starter? (Leader), role? (couronne) }
 *   DELETE /teams/:id/members/:userId          exclure (Leader ; un Leader : couronne)
 *   POST   /teams/me/leave                     quitter son équipe (24 h avant d'en rejoindre une autre)
 *   POST   /teams/:id/transfer                 transmettre la couronne { userId }
 *   DELETE /teams/:id                          dissoudre (couronne)
 *   POST   /teams/:id/report                   signaler une équipe     { reason, details? }
 *
 * Matchs d'équipe (BO3) :
 *   GET    /teams/:id/matches                  derniers matchs d'une équipe (public)
 *   GET    /teams/matches/:matchId             feuille de match (public ; droits du visiteur s'il est connecté)
 *   GET    /teams/me/play                      recherche en cours, match en cours, équipes en file
 *   POST   /teams/me/queue                     lancer la recherche (Leader) { roster: [ids des joueurs du match] }
 *   DELETE /teams/me/queue                     arrêter la recherche (Leader)
 *   POST   /teams/me/queue/stay                « Toujours là ? » : relancer les 30 min de recherche (Leader ou joueur inscrit)
 *   GET    /teams/players/:userId/matches      matchs de Division d'un joueur (historique du profil)
 *   POST   /teams/matches/:matchId/messages    chat du match { body }
 *   POST   /teams/matches/:matchId/code        code de la partie privée (équipe hôte, modifiable avant les scores) { code }
 *   POST   /teams/matches/:matchId/present     « Présents en jeu » (équipe)
 *   POST   /teams/matches/:matchId/forfeit     déclarer forfait { reason: host_silent | absent }
 *   POST   /teams/matches/:matchId/forfeit/answer  valider ou contester le forfait { accept }
 *   POST   /teams/matches/:matchId/report      déclarer toute la série à la fin (joueur du match ou Leader) { scores: [[a, b], …] } (point de vue de l'équipe 1)
 *   POST   /teams/matches/:matchId/confirm     confirmer ou contester (équipe adverse : joueur du match ou Leader) { accept }
 *   POST   /teams/matches/:matchId/map3        choisir la map 3 (équipe qui a gagné le plus de manches : joueur du match ou Leader) { map }
 *   POST   /teams/matches/:matchId/proofs      enregistrer une capture déjà envoyée (joueur du match) { path }
 *   GET    /teams/tournament                   tournoi prévu ou en cours (sinon le dernier terminé), tableau, droits du visiteur
 *   GET    /teams/tournaments/:id              un tournoi
 *   POST   /teams/tournaments/:id/checkin      check-in d'un joueur de l'équipe (2 h à 15 min avant) { roster: [ids parmi l'effectif figé] }
 *   POST   /teams/tournaments/:id/register     Coupe Horus : inscrire son équipe (Leader) ; DELETE : la désinscrire
 *   GET    /teams/tournament?kind=horus        Coupe Horus prévue ou en cours (sinon la dernière terminée) ; kind=anubis : Coupe Anubis ; kind=playin : play-in
 *   POST   /teams/tournaments/:id/register     Coupe Anubis : le joueur s'inscrit seul (DELETE : se désinscrit) ; checkin : check-in du joueur
 *   POST   /teams/tournaments/:id/squad        Coupe Anubis : le capitaine choisit les titulaires { roster }
 *   POST   /teams/matches/:matchId/correct     correction d'un match terminé (arbitre 48 h, admin sans limite) { scores | null, reason }
 *   POST   /teams/matches/:matchId/resolve     arbitrage { scores: [[a, b], …] | null (annuler) }
 */
export function teamsRouter(): Router {
  const router = Router();
  // Mode en pause (TEAM_MODE) : lectures seules, aucune action.
  router.use((req, res, next) => {
    if (config.teams.enabled || req.method === 'GET') return next();
    res.status(403).json({ error: { code: 'TEAM_MODE_PAUSED', message: 'La Division est en pause.' } });
  });

  router.get('/', asyncHandler(async (_req, res) => void res.json({ teams: await listTeams() })));
  router.get('/status', asyncHandler(async (_req, res) => void res.json(await teamStatus())));
  router.get('/leagues', asyncHandler(async (_req, res) => void res.json(await leagueState())));
  // Défis directs (scrims) : lancer, répondre, annuler ; défis de mon équipe.
  router.get('/me/challenges', requireAuth, asyncHandler(async (_req, res) => void res.json(await myChallenges(currentUser(res).id))));
  router.post('/challenges', requireAuth, asyncHandler(async (req, res) => void res.status(201).json(await createChallenge(currentUser(res).id, req.body))));
  router.post('/challenges/:challengeId/answer', requireAuth, asyncHandler(async (req, res) => void res.json(await answerChallenge(currentUser(res).id, uuidParam(req, 'challengeId'), req.body))));
  router.delete('/challenges/:challengeId', requireAuth, asyncHandler(async (req, res) => void res.json(await cancelChallenge(currentUser(res).id, uuidParam(req, 'challengeId')))));
  router.get('/report-reasons', (_req, res) => void res.json(TEAM_REPORT_REASONS));
  router.get('/me', requireAuth, asyncHandler(async (_req, res) => void res.json(await myTeamState(currentUser(res).id))));
  router.post('/me/leave', requireAuth, asyncHandler(async (_req, res) => void res.json(await leaveTeam(currentUser(res).id))));
  router.post('/', requireAuth, asyncHandler(async (req, res) => void res.status(201).json(await createTeam(currentUser(res).id, req.body))));

  // --- Matchs d'équipe (BO3) ----------------------------------------------------
  router.get('/me/play', requireAuth, asyncHandler(async (_req, res) => void res.json(await teamPlayState(currentUser(res).id))));
  router.post('/me/queue', requireAuth, asyncHandler(async (req, res) => void res.json(await joinTeamQueue(currentUser(res).id, req.body))));
  // Match programmé : créneaux pris (anonymes), programmer / annuler (Leaders).
  // Circuit : points des Coupes Horus de la saison, qualification de la grande finale.
  router.get('/circuit', asyncHandler(async (_req, res) => void res.json(await getCircuit())));
  router.get('/schedule/slots', asyncHandler(async (_req, res) => void res.json(await scheduleSlots())));
  router.post('/me/schedule', requireAuth, asyncHandler(async (req, res) => void res.json(await scheduleTeamMatch(currentUser(res).id, req.body))));
  router.delete('/me/schedule', requireAuth, asyncHandler(async (_req, res) => void res.json(await cancelTeamSchedule(currentUser(res).id))));
  router.post('/me/queue/stay', requireAuth, asyncHandler(async (_req, res) => void res.json(await stayInTeamQueue(currentUser(res).id))));
  router.get('/players/:userId/matches', asyncHandler(async (req, res) => void res.json({ matches: await playerTeamMatches(uuidParam(req, 'userId')) })));
  router.post('/matches/:matchId/messages', requireAuth, asyncHandler(async (req, res) => void res.json(await postTeamMessage(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/code', requireAuth, asyncHandler(async (req, res) => void res.json(await setTeamGameCode(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/present', requireAuth, asyncHandler(async (req, res) => void res.json(await markTeamPresent(currentUser(res).id, uuidParam(req, 'matchId')))));
  router.post('/matches/:matchId/forfeit', requireAuth, asyncHandler(async (req, res) => void res.json(await claimTeamForfeit(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/forfeit/answer', requireAuth, asyncHandler(async (req, res) => void res.json(await answerTeamForfeit(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.delete('/me/queue', requireAuth, asyncHandler(async (_req, res) => void res.json(await leaveTeamQueue(currentUser(res).id))));
  router.get('/matches/:matchId', optionalAuth, asyncHandler(async (req, res) => void res.json(await getTeamMatch(uuidParam(req, 'matchId'), viewerOf(res)?.id ?? null))));
  router.post('/matches/:matchId/report', requireAuth, asyncHandler(async (req, res) => void res.json(await reportTeamScores(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/confirm', requireAuth, asyncHandler(async (req, res) => void res.json(await confirmTeamScores(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/map3', requireAuth, asyncHandler(async (req, res) => void res.json(await pickTeamMap3(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/proofs', requireAuth, asyncHandler(async (req, res) => void res.json(await addTeamProof(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/correct', requireAuth, asyncHandler(async (req, res) => void res.json(await correctTeamMatch(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));
  router.post('/matches/:matchId/resolve', requireAuth, asyncHandler(async (req, res) => void res.json(await resolveTeamMatch(currentUser(res).id, uuidParam(req, 'matchId'), req.body))));

  // --- Tournoi de fin de saison ------------------------------------------------------
  router.get(
    '/tournament',
    optionalAuth,
    asyncHandler(async (req, res) => void res.json({ tournament: await currentTournament(viewerOf(res)?.id ?? null, req.query.kind === 'horus' || req.query.kind === 'anubis' || req.query.kind === 'playin' ? req.query.kind : 'saison') })),
  );
  // Liste des coupes (page Tournoi) : prochaines et dernières terminées, avec leur affiche.
  router.get('/cups', asyncHandler(async (_req, res) => void res.json(await listCups())));
  router.get('/tournaments/:tournamentId', optionalAuth, asyncHandler(async (req, res) => void res.json(await getTournament(uuidParam(req, 'tournamentId'), viewerOf(res)?.id ?? null))));
  router.post('/tournaments/:tournamentId/checkin', requireAuth, asyncHandler(async (req, res) => void res.json(await checkIn(currentUser(res).id, uuidParam(req, 'tournamentId'), req.body))));
  router.post('/tournaments/:tournamentId/register', requireAuth, asyncHandler(async (req, res) => void res.json(await registerTeam(currentUser(res).id, uuidParam(req, 'tournamentId')))));
  router.post('/tournaments/:tournamentId/squad', requireAuth, asyncHandler(async (req, res) => void res.json(await setSquadRoster(currentUser(res).id, uuidParam(req, 'tournamentId'), req.body))));
  router.delete('/tournaments/:tournamentId/register', requireAuth, asyncHandler(async (req, res) => void res.json(await unregisterTeam(currentUser(res).id, uuidParam(req, 'tournamentId')))));

  router.post('/invites/:inviteId/answer', requireAuth, asyncHandler(async (req, res) => void res.json(await answerInvite(currentUser(res).id, req.params.inviteId, req.body))));
  router.delete('/invites/:inviteId', requireAuth, asyncHandler(async (req, res) => void res.json(await cancelInvite(currentUser(res).id, req.params.inviteId))));

  // Lien d'invitation : aperçu public, arrivée directe (connecté), lien de l'équipe (Leader).
  router.get('/join/:code', asyncHandler(async (req, res) => void res.json(await inviteLinkPreview(req.params.code))));
  router.post('/join/:code', requireAuth, asyncHandler(async (req, res) => void res.json(await joinByInviteLink(currentUser(res).id, req.params.code))));
  router.get('/:id/invite-link', requireAuth, asyncHandler(async (req, res) => void res.json(await teamInviteLink(currentUser(res).id, uuidParam(req, 'id')))));
  router.post('/:id/invite-link/reset', requireAuth, asyncHandler(async (req, res) => void res.json(await teamInviteLink(currentUser(res).id, uuidParam(req, 'id'), true))));
  router.get('/:id', asyncHandler(async (req, res) => void res.json(await getTeam(uuidParam(req, 'id')))));
  router.get('/:id/matches', asyncHandler(async (req, res) => void res.json({ matches: await teamMatchHistory(uuidParam(req, 'id')) })));
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
