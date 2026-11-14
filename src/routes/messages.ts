import { Router } from 'express';
import { currentUser, requireAuth } from '../auth.js';
import { asyncHandler, uuidParam } from '../errors.js';
import {
  blockPlayer,
  conversations,
  conversationWith,
  markRead,
  messageSettings,
  reportConversation,
  searchPlayers,
  sendMessage,
  setMessageSettings,
  unblockPlayer,
  unreadCount,
} from '../services/messages.js';

/**
 * Messagerie entre joueurs (connexion requise).
 *
 *   GET  /messages                  conversations (autre joueur, dernier message, non lus) et total non lus
 *   GET  /messages/unread           nombre de messages non lus (enveloppe de la barre du haut)
 *   GET  /messages/search?q=        joueurs à qui écrire, par pseudo
 *   GET  /messages/:userId          conversation avec ce joueur (?before=<id> pour remonter) ; reçus marqués lus
 *   POST /messages/:userId          { body } envoyer un message
 *   POST /messages/:userId/read     marquer lus les messages reçus de ce joueur
 *   GET|POST /messages/settings     { allow: all | team | none } qui peut m'écrire ; joueurs bloqués
 *   POST|DELETE /messages/:userId/block   bloquer / débloquer
 *   POST /messages/:userId/report   { reason, details } signaler la conversation (copie des 50 derniers messages)
 */
export function messagesRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', asyncHandler(async (_req, res) => void res.json(await conversations(currentUser(res).id))));
  router.get('/unread', asyncHandler(async (_req, res) => void res.json(await unreadCount(currentUser(res).id))));
  router.get('/search', asyncHandler(async (req, res) => void res.json(await searchPlayers(currentUser(res).id, req.query.q))));
  router.get('/settings', asyncHandler(async (_req, res) => void res.json(await messageSettings(currentUser(res).id))));
  router.post('/settings', asyncHandler(async (req, res) => void res.json(await setMessageSettings(currentUser(res).id, req.body))));
  router.get(
    '/:userId',
    asyncHandler(async (req, res) => {
      const before = Number.parseInt(String(req.query.before ?? ''), 10);
      res.json(await conversationWith(currentUser(res).id, uuidParam(req, 'userId'), Number.isFinite(before) ? before : null));
    }),
  );
  router.post('/:userId', asyncHandler(async (req, res) => void res.status(201).json(await sendMessage(currentUser(res).id, uuidParam(req, 'userId'), req.body))));
  router.post('/:userId/read', asyncHandler(async (req, res) => void res.json(await markRead(currentUser(res).id, uuidParam(req, 'userId')))));
  router.post('/:userId/block', asyncHandler(async (req, res) => void res.json(await blockPlayer(currentUser(res).id, uuidParam(req, 'userId')))));
  router.delete('/:userId/block', asyncHandler(async (req, res) => void res.json(await unblockPlayer(currentUser(res).id, uuidParam(req, 'userId')))));
  router.post('/:userId/report', asyncHandler(async (req, res) => void res.status(201).json(await reportConversation(currentUser(res).id, uuidParam(req, 'userId'), req.body))));

  return router;
}
