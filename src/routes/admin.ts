import { Router } from 'express';
import { currentUser, requireAdmin, requireAuth } from '../auth.js';
import { HttpError, asyncHandler, unwrap, uuidParam } from '../errors.js';
import { STAFF_BADGES, overview, parseBadges, parseEventPatch, parseFounder, parsePartner, searchPlayers } from '../services/admin.js';
import { createEvent, parseNewEvent } from '../services/gtaEvents.js';
import { listDisputes, resolveMatch } from '../services/matches.js';
import { closeCase, listForAdmin } from '../services/moderation.js';
import { supabase } from '../supabase.js';

/**
 * Administration (rôle admin obligatoire sur toutes les routes).
 *
 *   GET    /admin/overview                 chiffres du tableau de bord
 *   GET    /admin/disputes                 matchs contestés
 *   GET    /admin/arbitrations?status=     demandes d'arbitrage (open | resolved | rejected)
 *   POST   /admin/arbitrations/:id         { status, resolution } traiter une demande
 *   GET    /admin/reports?status=          signalements de joueurs
 *   POST   /admin/reports/:id              { status, resolution } traiter un signalement
 *   POST   /admin/matches/:id/cancel       annuler un match
 *   POST   /admin/events                   créer un événement GTA 6
 *   PATCH  /admin/events/:id               modifier (titre, dates, places, statut…)
 *   DELETE /admin/events/:id               supprimer
 *   POST|PATCH|DELETE /admin/founders[/:id]  fondateurs
 *   POST|PATCH|DELETE /admin/partners[/:id]  partenaires
 *   GET    /admin/players?q=               rechercher des joueurs
 *   POST   /admin/players/:id/badges       { badges: [...] }
 *   POST   /admin/players/:id/role         { role: "member" | "admin" }
 *   POST   /admin/players/:id/unban        lever une exclusion de la file
 *   POST   /admin/season/close             { nextName } clôturer la saison
 */
export function adminRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireAdmin);

  router.get('/overview', asyncHandler(async (_req, res) => {
    res.json({ ...(await overview()), staffBadges: STAFF_BADGES });
  }));

  // --- Matchs ----------------------------------------------------------------
  router.get('/disputes', asyncHandler(async (_req, res) => {
    res.json({ matches: await listDisputes() });
  }));

  // --- Arbitrages et signalements ------------------------------------------------
  router.get('/arbitrations', asyncHandler(async (req, res) => {
    res.json({ items: await listForAdmin('cod_arbitration_requests', req.query.status) });
  }));
  router.post('/arbitrations/:id', asyncHandler(async (req, res) => {
    res.json({ item: await closeCase('cod_arbitration_requests', req.params.id, currentUser(res).id, req.body) });
  }));
  router.get('/reports', asyncHandler(async (req, res) => {
    res.json({ items: await listForAdmin('cod_player_reports', req.query.status) });
  }));
  router.post('/reports/:id', asyncHandler(async (req, res) => {
    res.json({ item: await closeCase('cod_player_reports', req.params.id, currentUser(res).id, req.body) });
  }));

  router.post('/matches/:id/cancel', asyncHandler(async (req, res) => {
    res.json({ match: await resolveMatch(uuidParam(req, 'id'), null) });
  }));

  // --- Événements GTA 6 --------------------------------------------------------
  router.post('/events', asyncHandler(async (req, res) => {
    res.status(201).json({ event: await createEvent(parseNewEvent(req.body), currentUser(res).id) });
  }));

  router.patch('/events/:id', asyncHandler(async (req, res) => {
    const patch = parseEventPatch(req.body);
    const event = unwrap(await supabase.from('gta_events').update(patch).eq('id', uuidParam(req, 'id')).select('*').maybeSingle());
    if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Événement introuvable.');
    res.json({ event });
  }));

  router.delete('/events/:id', asyncHandler(async (req, res) => {
    unwrap(await supabase.from('gta_events').delete().eq('id', uuidParam(req, 'id')));
    res.json({ deleted: true });
  }));

  // --- Fondateurs et partenaires (même schéma CRUD) ------------------------------
  const crud = (table: 'founders' | 'partners', parse: (body: unknown, partial?: boolean) => Record<string, unknown>) => {
    router.post(`/${table}`, asyncHandler(async (req, res) => {
      res.status(201).json({ item: unwrap(await supabase.from(table).insert(parse(req.body)).select('*').single()) });
    }));
    router.patch(`/${table}/:id`, asyncHandler(async (req, res) => {
      const item = unwrap(await supabase.from(table).update(parse(req.body, true)).eq('id', uuidParam(req, 'id')).select('*').maybeSingle());
      if (!item) throw new HttpError(404, 'NOT_FOUND', 'Élément introuvable.');
      res.json({ item });
    }));
    router.delete(`/${table}/:id`, asyncHandler(async (req, res) => {
      unwrap(await supabase.from(table).delete().eq('id', uuidParam(req, 'id')));
      res.json({ deleted: true });
    }));
  };
  crud('founders', parseFounder);
  crud('partners', parsePartner);

  // --- Joueurs -----------------------------------------------------------------
  router.get('/players', asyncHandler(async (req, res) => {
    res.json({ players: await searchPlayers(typeof req.query.q === 'string' ? req.query.q : '') });
  }));

  router.post('/players/:id/badges', asyncHandler(async (req, res) => {
    const badges = parseBadges(req.body);
    unwrap(await supabase.from('cod_profiles').update({ badges }).eq('user_id', uuidParam(req, 'id')));
    res.json({ badges });
  }));

  router.post('/players/:id/role', asyncHandler(async (req, res) => {
    const role = (req.body as { role?: unknown } | undefined)?.role;
    if (role !== 'member' && role !== 'admin') throw new HttpError(400, 'INVALID_INPUT', 'Rôle invalide.');
    const id = uuidParam(req, 'id');
    if (id === currentUser(res).id && role !== 'admin') {
      throw new HttpError(400, 'INVALID_INPUT', 'Tu ne peux pas retirer ton propre rôle administrateur.');
    }
    unwrap(await supabase.from('users').update({ role }).eq('id', id));
    res.json({ role });
  }));

  router.post('/players/:id/unban', asyncHandler(async (req, res) => {
    unwrap(await supabase.from('cod_profiles').update({ banned_until: null }).eq('user_id', uuidParam(req, 'id')));
    res.json({ unbanned: true });
  }));

  // --- Saison ------------------------------------------------------------------
  router.post('/season/close', asyncHandler(async (req, res) => {
    const nextName = (req.body as { nextName?: unknown } | undefined)?.nextName;
    const archived = unwrap(await supabase.rpc('cod_close_season', { p_next_name: typeof nextName === 'string' ? nextName : '' }));
    res.json({ archived });
  }));

  return router;
}
