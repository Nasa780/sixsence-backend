import { Router, type RequestHandler } from 'express';
import { currentUser, requireAuth, requireRoles } from '../auth.js';
import { ROLES, rolesFor, type Role } from '../roles.js';
import { HttpError, asyncHandler, unwrap, uuidParam } from '../errors.js';
import { STAFF_BADGES, listCorrections, overview, parseBadges, parseEventPatch, parseFounder, parsePartner, recentMatches, searchPlayers } from '../services/admin.js';
import { createEvent, parseNewEvent } from '../services/gtaEvents.js';
import { listDisputes, resolveMatch } from '../services/matches.js';
import { closeCase, listForAdmin } from '../services/moderation.js';
import { announceEventCancelled, announceNewEvent, announceSeasonClosed, onBadgesChanged, onTeamRoleChanged, syncAllRankRoles, syncTeamAndBadgeRoles } from '../services/community.js';
import { applySanction, liftSanction, listSanctions } from '../services/sanctions.js';
import { forgetSeasons, syncAllCards, syncCards } from '../services/cards.js';
import { syncTeamRole } from '../services/teamDiscord.js';
import { listTeamDisputes } from '../services/teamMatches.js';
import { cancelTournament, createTournament, forceEntryWinner, listTournaments, previewQualified } from '../services/tournaments.js';
import { adminDisbandTeam, adminTeamReports, adminTeams, closeTeamReport, moderateTeam } from '../services/teams.js';
import { supabase } from '../supabase.js';

/**
 * Administration. Droits selon le rôle (voir guard ci-dessous) :
 *   arbitre : tableau de bord, contestations, demandes d'arbitrage
 *   staff   : + signalements, recherche de joueurs, sanctions et équipes
 *   admin   : tout
 *
 *   GET    /admin/overview                 chiffres du tableau de bord
 *   GET    /admin/disputes                 matchs contestés
 *   GET    /admin/team-disputes            matchs d'équipe contestés (arbitrage sur la feuille de match)
 *   GET    /admin/matches?q=               matchs récents (recherche par pseudo), corrections et demandes en attente
 *   GET    /admin/corrections              historique des corrections de matchs terminés (admin)
 *   GET    /admin/arbitrations?status=&match=  demandes d'arbitrage (open | resolved | rejected), d'un match
 *   POST   /admin/arbitrations/:id         { status, resolution } traiter une demande
 *   GET    /admin/reports?status=          signalements de joueurs
 *   POST   /admin/reports/:id              { status, resolution } traiter un signalement
 *   GET    /admin/teams?q=                 équipes actives (signalées d'abord)
 *   PATCH  /admin/teams/:id                { clearLogo?, clearBanner?, clearDescription?, name?, tag? } modérer une fiche
 *   DELETE /admin/teams/:id                dissoudre une équipe
 *   GET    /admin/team-reports?status=     signalements d'équipes
 *   POST   /admin/team-reports/:id         { status: "resolved" | "rejected" }
 *   GET    /admin/tournaments              derniers tournois (admin)
 *   GET    /admin/tournaments/preview?size= qualifiés si le tournoi était créé maintenant
 *   POST   /admin/tournaments              { name, startsAt, size } créer le tournoi (qualifiés et effectifs figés)
 *   DELETE /admin/tournaments/:id          annuler le tournoi
 *   POST   /admin/tournaments/:id/entries/:entryId/winner { side } désigner le vainqueur d'une rencontre
 *   POST   /admin/matches/:id/cancel       annuler un match
 *   POST   /admin/events                   créer un événement GTA 6
 *   PATCH  /admin/events/:id               modifier (titre, dates, places, statut…)
 *   DELETE /admin/events/:id               supprimer
 *   POST|PATCH|DELETE /admin/founders[/:id]  fondateurs
 *   POST|PATCH|DELETE /admin/partners[/:id]  partenaires
 *   GET    /admin/players?q=&offset=       rechercher des joueurs (pseudo même stylisé, identifiant Activision ; 50 par page)
 *   POST   /admin/players/:id/badges       { badges: [...] }
 *   POST   /admin/players/:id/role         { role: "member" | "arbitre" | "staff" | "admin" }
 *   GET    /admin/players/:id/sanctions    historique des sanctions d'un joueur
 *   POST   /admin/players/:id/sanctions    { type, reason, minutes?, points?, reportId? } sanctionner
 *   POST   /admin/sanctions/:id/lift       { reason? } lever une sanction
 *   POST   /admin/players/:id/unban        lever une exclusion de la file
 *   POST   /admin/season/close             { nextName } clôturer la saison
 *   POST   /admin/discord/sync-roles       remettre à jour les rôles Discord (rangs, équipe, badges, MVP du mois, rôles des équipes)
 */
const guard: RequestHandler = (req, res, next) => requireRoles(...rolesFor(req.method, req.path))(req, res, next);

export function adminRouter(): Router {
  const router = Router();
  router.use(requireAuth, guard);

  router.get('/overview', asyncHandler(async (_req, res) => {
    res.json({ ...(await overview()), staffBadges: STAFF_BADGES });
  }));

  // --- Matchs ----------------------------------------------------------------
  router.get('/disputes', asyncHandler(async (_req, res) => {
    res.json({ matches: await listDisputes() });
  }));
  router.get('/team-disputes', asyncHandler(async (_req, res) => {
    res.json({ matches: await listTeamDisputes() });
  }));
  router.get('/matches', asyncHandler(async (req, res) => {
    res.json({ matches: await recentMatches(typeof req.query.q === 'string' ? req.query.q : '') });
  }));
  router.get('/corrections', asyncHandler(async (_req, res) => {
    res.json({ items: await listCorrections() });
  }));

  // --- Arbitrages et signalements ------------------------------------------------
  router.get('/arbitrations', asyncHandler(async (req, res) => {
    res.json({ items: await listForAdmin('cod_arbitration_requests', req.query.status, req.query.match) });
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

  // --- Équipes (Match team) ----------------------------------------------------
  router.get('/teams', asyncHandler(async (req, res) => {
    res.json({ teams: await adminTeams(req.query.q) });
  }));
  router.patch('/teams/:id', asyncHandler(async (req, res) => {
    res.json({ team: await moderateTeam(currentUser(res).id, uuidParam(req, 'id'), req.body) });
  }));
  router.delete('/teams/:id', asyncHandler(async (req, res) => {
    res.json(await adminDisbandTeam(currentUser(res).id, uuidParam(req, 'id')));
  }));
  router.get('/team-reports', asyncHandler(async (req, res) => {
    res.json({ items: await adminTeamReports(req.query.status) });
  }));
  router.post('/team-reports/:id', asyncHandler(async (req, res) => {
    res.json(await closeTeamReport(currentUser(res).id, req.params.id, req.body));
  }));

  // --- Tournoi de fin de saison (admin) ----------------------------------------------
  router.get('/tournaments', asyncHandler(async (_req, res) => {
    res.json({ tournaments: await listTournaments() });
  }));
  router.get('/tournaments/preview', asyncHandler(async (req, res) => {
    res.json(await previewQualified(req.query.size));
  }));
  router.post('/tournaments', asyncHandler(async (req, res) => {
    res.status(201).json(await createTournament(currentUser(res).id, req.body));
  }));
  router.delete('/tournaments/:id', asyncHandler(async (req, res) => {
    res.json(await cancelTournament(uuidParam(req, 'id')));
  }));
  router.post('/tournaments/:id/entries/:entryId/winner', asyncHandler(async (req, res) => {
    res.json(await forceEntryWinner(uuidParam(req, 'id'), req.params.entryId, req.body));
  }));

  router.post('/matches/:id/cancel', asyncHandler(async (req, res) => {
    res.json({ match: await resolveMatch(uuidParam(req, 'id'), null) });
  }));

  // --- Événements GTA 6 --------------------------------------------------------
  router.post('/events', asyncHandler(async (req, res) => {
    const event = await createEvent(parseNewEvent(req.body), currentUser(res).id);
    void announceNewEvent(event);
    res.status(201).json({ event });
  }));

  router.patch('/events/:id', asyncHandler(async (req, res) => {
    const id = uuidParam(req, 'id');
    const patch: Record<string, unknown> = parseEventPatch(req.body);
    const before = unwrap(await supabase.from('gta_events').select('status, starts_at').eq('id', id).maybeSingle()) as {
      status: string;
      starts_at: string;
    } | null;
    if (!before) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Événement introuvable.');
    // Nouvelle date : le rappel 1 h avant sera renvoyé pour le nouvel horaire.
    if (typeof patch.starts_at === 'string' && new Date(patch.starts_at).getTime() !== new Date(before.starts_at).getTime()) {
      patch.reminder_sent_at = null;
    }
    const event = unwrap(await supabase.from('gta_events').update(patch).eq('id', id).select('*').maybeSingle()) as {
      id: string;
      title: string;
      starts_at: string;
      location: string | null;
      status: string;
    } | null;
    if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Événement introuvable.');
    if (before.status !== 'published' && event.status === 'published') void announceNewEvent(event);
    if (before.status === 'published' && event.status === 'cancelled') void announceEventCancelled(event);
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
    res.json(await searchPlayers(typeof req.query.q === 'string' ? req.query.q : '', Number(req.query.offset) || 0));
  }));

  router.post('/players/:id/badges', asyncHandler(async (req, res) => {
    const badges = parseBadges(req.body);
    const id = uuidParam(req, 'id');
    const { data: before } = await supabase.from('cod_profiles').select('badges').eq('user_id', id).maybeSingle();
    unwrap(await supabase.from('cod_profiles').update({ badges }).eq('user_id', id));
    void onBadgesChanged(id, ((before as { badges?: string[] } | null)?.badges ?? []), badges);
    void syncCards(id).catch(() => {});
    res.json({ badges });
  }));

  router.post('/players/:id/role', asyncHandler(async (req, res) => {
    const role = (req.body as { role?: unknown } | undefined)?.role as Role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'INVALID_INPUT', 'Rôle invalide.');
    const id = uuidParam(req, 'id');
    if (id === currentUser(res).id && role !== 'admin') {
      throw new HttpError(400, 'INVALID_INPUT', 'Tu ne peux pas retirer ton propre rôle administrateur.');
    }
    const { data: before } = await supabase.from('users').select('role').eq('id', id).maybeSingle();
    unwrap(await supabase.from('users').update({ role }).eq('id', id));
    void onTeamRoleChanged(id, ((before as { role?: Role } | null)?.role ?? 'member'), role);
    void syncCards(id).catch(() => {});
    res.json({ role });
  }));

  // --- Sanctions (admin et staff) ------------------------------------------------
  router.get('/players/:id/sanctions', asyncHandler(async (req, res) => {
    res.json({ sanctions: await listSanctions(uuidParam(req, 'id')) });
  }));
  router.post('/players/:id/sanctions', asyncHandler(async (req, res) => {
    res.status(201).json({ sanction: await applySanction(uuidParam(req, 'id'), req.body, currentUser(res).id) });
  }));
  router.post('/sanctions/:id/lift', asyncHandler(async (req, res) => {
    res.json({ sanction: await liftSanction(req.params.id, currentUser(res).id, req.body) });
  }));

  router.post('/players/:id/unban', asyncHandler(async (req, res) => {
    unwrap(await supabase.from('cod_profiles').update({ banned_until: null }).eq('user_id', uuidParam(req, 'id')));
    res.json({ unbanned: true });
  }));

  // --- Saison ------------------------------------------------------------------
  router.post('/season/close', asyncHandler(async (req, res) => {
    const nextName = (req.body as { nextName?: unknown } | undefined)?.nextName;
    const closing = unwrap(await supabase.from('seasons').select('id').eq('is_active', true).maybeSingle()) as { id: number } | null;
    const archived = unwrap(await supabase.rpc('cod_close_season', { p_next_name: typeof nextName === 'string' ? nextName : '' })) as number;
    // Équipes : classement final archivé, points remis à 1 000.
    if (closing) unwrap(await supabase.rpc('team_close_season', { p_season: closing.id }));
    void announceSeasonClosed(archived, String(nextName).trim());
    // Points remis à zéro : les rangs Discord suivent ; cartes de la saison attribuées.
    void syncAllRankRoles();
    forgetSeasons();
    void syncAllCards().catch(() => {});
    res.json({ archived });
  }));

  // --- Discord -------------------------------------------------------------------
  router.post('/discord/sync-roles', asyncHandler(async (_req, res) => {
    const ranks = await syncAllRankRoles();
    const others = await syncTeamAndBadgeRoles();
    // Rôles des équipes (Match team) : créés s'ils manquent, effectifs remis à jour.
    const teams = (unwrap(await supabase.from('teams').select('id').is('disbanded_at', null)) ?? []) as { id: string }[];
    for (const team of teams) syncTeamRole(team.id);
    res.json({ updated: ranks + others });
  }));

  return router;
}
