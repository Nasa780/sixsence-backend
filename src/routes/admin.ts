import { Router, type RequestHandler } from 'express';
import { currentUser, requireAuth, requireRoles } from '../auth.js';
import { config } from '../config.js';
import { ROLES, rolesFor, type Role } from '../roles.js';
import { HttpError, asyncHandler, unwrap, uuidParam } from '../errors.js';
import { STAFF_BADGES, listCorrections, overview, parseBadges, parseEventPatch, parseFounder, parsePartner, recentMatches, recentTeamMatches, searchPlayers } from '../services/admin.js';
import { createEvent, parseNewEvent } from '../services/gtaEvents.js';
import { listDisputes, resolveMatch } from '../services/matches.js';
import { closeCase, listForAdmin } from '../services/moderation.js';
import { announceEventCancelled, announceNewEvent, announceSeasonClosed, onBadgesChanged, onTeamRoleChanged, syncAllRankRoles, syncTeamAndBadgeRoles } from '../services/community.js';
import { applySanction, liftSanction, listSanctions } from '../services/sanctions.js';
import { forgetSeasons, syncAllCards, syncCards } from '../services/cards.js';
import { publishRules } from '../services/discordRules.js';
import { setMapPools } from '../services/maps.js';
import { publishTicketPanel } from '../services/tickets.js';
import { announceSettings, createOnboardingRoles, giveMemberRoleToAll, manualAnnouncement, setDisabledTypes } from '../services/announcements.js';
import { syncTeamRole } from '../services/teamDiscord.js';
import { listTeamDisputes } from '../services/teamMatches.js';
import {
  cancelTournament,
  createCup,
  setCupPoster,
  setSchedulePoster,
  createSchedule,
  createPlayIn,
  createTournament,
  cupAdmin,
  deleteSchedule,
  forceEntryWinner,
  listTournaments,
  playInOverview,
  previewQualified,
  setCupsAuto,
  updateSchedule,
} from '../services/tournaments.js';
import { adminDisbandTeam, adminTeamReports, adminTeams, closeTeamReport, moderateTeam } from '../services/teams.js';
import { missedReadyChecks } from '../services/missedReady.js';
import { supabase } from '../supabase.js';
import { activateLeagues, prepareLeagueMoves } from '../services/leagues.js';

/**
 * Administration. Droits selon le rôle (voir guard ci-dessous) :
 *   arbitre : tableau de bord, contestations, demandes d'arbitrage
 *   staff   : + signalements, recherche de joueurs, sanctions et équipes
 *   admin   : tout
 *
 *   GET    /admin/overview                 chiffres du tableau de bord
 *   GET    /admin/disputes                 matchs contestés
 *   GET    /admin/team-disputes            matchs d'équipe contestés (arbitrage sur la feuille de match)
 *   GET    /admin/matches?q=               matchs récents classés et de Division (recherche par pseudo, nom ou tag d'équipe)
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
 *   GET    /admin/playin?size=             play-in de la saison (ou affiches d'après le classement actuel)
 *   POST   /admin/playin                   { startsAt, size } créer le play-in (7e et 8e du circuit contre 2 équipes de Division)
 *   DELETE /admin/tournaments/:id          annuler le tournoi
 *   POST   /admin/tournaments/:id/entries/:entryId/winner { side } désigner le vainqueur d'une rencontre
 *   GET    /admin/cups                      Coupe Horus : interrupteur, rendez-vous, dernières coupes (admin)
 *   POST   /admin/cups/auto                 { on } coupes automatiques activées ou non
 *   POST   /admin/cups                      { name, startsAt, size, bestOf, finalBestOf } coupe ponctuelle
 *   POST   /admin/cups/schedules            { name, weekday, time, size, bestOf, finalBestOf } rendez-vous récurrent
 *   PATCH  /admin/cups/schedules/:id        { active } ou tous les champs ; DELETE : supprimer le rendez-vous
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
 *   GET    /admin/missed-ready             derniers « Prêt ? » manqués (joueur, match, nombre sur 7 jours)
 *   POST   /admin/players/:id/unban        lever une exclusion de la file
 *   POST   /admin/season/close             { nextName } clôturer la saison (ligues : montées et descentes)
 *   POST   /admin/leagues/activate         première répartition des équipes en ligues (16 équipes au moins)
 *   POST   /admin/season/end-date          { endsAt | null } date de fin prévue de la saison active
 *   POST   /admin/discord/rules            publier ou mettre à jour le règlement du serveur (bot, DISCORD_RULES_CHANNEL_ID)
 *   GET    /admin/discord/announce         annonces illustrées : salon configuré, types coupés, rôles d'Intégration
 *   POST   /admin/discord/announce         publier une annonce libre ou les nouveautés { type, title, text, url }
 *   POST   /admin/discord/announce/settings  types d'annonces coupés { disabled: [...] }
 *   POST   /admin/discord/member-role      donner le rôle « Membre » à tous les membres actuels du serveur (tâche de fond)
 *   POST   /admin/discord/onboarding-roles créer les rôles d'Intégration qui manquent (notifications, plateformes, Membre)
 *   POST   /admin/discord/tickets-panel    publier ou mettre à jour le panneau des tickets (DISCORD_TICKETS_CHANNEL_ID)
 *   POST   /admin/maps                     map pool de chaque mode { classe: [...], division: [...], tournoi: [...] }
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
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    // Classé et Division : deux listes, que le site affiche ensemble avec une étiquette par mode.
    const [matches, teamMatches] = await Promise.all([recentMatches(q), recentTeamMatches(q)]);
    res.json({ matches, teamMatches });
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

  // --- Équipes (Division) ----------------------------------------------------
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
  router.get('/playin', asyncHandler(async (req, res) => {
    res.json({ playIn: await playInOverview(Number(req.query.size) || 8) });
  }));
  router.post('/playin', asyncHandler(async (req, res) => {
    res.status(201).json({ playIn: await createPlayIn(currentUser(res).id, req.body) });
  }));
  router.delete('/tournaments/:id', asyncHandler(async (req, res) => {
    res.json(await cancelTournament(uuidParam(req, 'id')));
  }));
  // --- Coupe Horus (admin) --------------------------------------------------------------
  router.get('/cups', asyncHandler(async (_req, res) => void res.json(await cupAdmin())));
  router.post('/cups/auto', asyncHandler(async (req, res) => void res.json(await setCupsAuto(req.body))));
  router.post('/cups', asyncHandler(async (req, res) => void res.status(201).json(await createCup(currentUser(res).id, req.body))));
  router.post('/cups/schedules', asyncHandler(async (req, res) => void res.status(201).json(await createSchedule(currentUser(res).id, req.body))));
  router.patch('/cups/schedules/:id', asyncHandler(async (req, res) => void res.json(await updateSchedule(uuidParam(req, 'id'), req.body))));
  // Affiche d'une coupe ou d'un rendez-vous : { posterUrl } (image du bucket cup-posters) ou null.
  router.post('/cups/:id/poster', asyncHandler(async (req, res) => void res.json(await setCupPoster(uuidParam(req, 'id'), req.body))));
  router.post('/cups/schedules/:id/poster', asyncHandler(async (req, res) => void res.json(await setSchedulePoster(uuidParam(req, 'id'), req.body))));
  router.delete('/cups/schedules/:id', asyncHandler(async (req, res) => void res.json(await deleteSchedule(uuidParam(req, 'id')))));

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
  router.get('/missed-ready', asyncHandler(async (_req, res) => {
    res.json({ missed: await missedReadyChecks() });
  }));
  router.post('/sanctions/:id/lift', asyncHandler(async (req, res) => {
    res.json({ sanction: await liftSanction(req.params.id, currentUser(res).id, req.body) });
  }));

  router.post('/players/:id/unban', asyncHandler(async (req, res) => {
    unwrap(await supabase.from('cod_profiles').update({ banned_until: null }).eq('user_id', uuidParam(req, 'id')));
    res.json({ unbanned: true });
  }));

  // --- Saison ------------------------------------------------------------------
  // Date de fin prévue (affichée, et verrou des transferts d'équipe les derniers jours) ; null pour l'effacer.
  router.post('/season/end-date', asyncHandler(async (req, res) => {
    const value = (req.body as { endsAt?: unknown } | undefined)?.endsAt;
    const endsAt = value === null || value === '' ? null : typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
    if (endsAt === undefined) throw new HttpError(400, 'INVALID_DATE', 'Date invalide.');
    if (endsAt && new Date(endsAt).getTime() < Date.now()) throw new HttpError(400, 'INVALID_DATE', 'La date de fin doit être dans le futur.');
    const season = unwrap(await supabase.from('seasons').update({ ends_at: endsAt }).eq('is_active', true).select('id, name, starts_at, ends_at').maybeSingle());
    forgetSeasons();
    res.json({ season });
  }));
  router.post('/leagues/activate', asyncHandler(async (_req, res) => void res.json(await activateLeagues())));
  router.post('/season/close', asyncHandler(async (req, res) => {
    const nextName = (req.body as { nextName?: unknown } | undefined)?.nextName;
    const closing = unwrap(await supabase.from('seasons').select('id').eq('is_active', true).maybeSingle()) as { id: number } | null;
    // Ligues : montées et descentes calculées sur le classement avant sa remise à zéro.
    const applyLeagues = await prepareLeagueMoves();
    const archived = unwrap(await supabase.rpc('cod_close_season', { p_next_name: typeof nextName === 'string' ? nextName : '' })) as number;
    // Équipes : classement final archivé, points remis à 1 000.
    if (closing) unwrap(await supabase.rpc('team_close_season', { p_season: closing.id }));
    if (closing) await applyLeagues(closing.id).catch((caught: Error) => console.error('[ligues] fin de saison impossible', caught.message));
    void announceSeasonClosed(archived, String(nextName).trim());
    // Points remis à zéro : les rangs Discord suivent ; cartes de la saison attribuées.
    void syncAllRankRoles();
    forgetSeasons();
    void syncAllCards().catch(() => {});
    res.json({ archived });
  }));

  // --- Discord -------------------------------------------------------------------
  router.post('/discord/rules', asyncHandler(async (_req, res) => {
    res.json(await publishRules());
  }));
  router.get('/discord/announce', asyncHandler(async (_req, res) => {
    res.json(await announceSettings());
  }));
  router.post('/discord/announce', asyncHandler(async (req, res) => {
    res.json(await manualAnnouncement(req.body));
  }));
  router.post('/discord/announce/settings', asyncHandler(async (req, res) => {
    res.json(await setDisabledTypes(req.body));
  }));
  router.post('/discord/member-role', asyncHandler(async (_req, res) => {
    res.json(await giveMemberRoleToAll());
  }));
  router.post('/discord/onboarding-roles', asyncHandler(async (_req, res) => {
    res.json(await createOnboardingRoles());
  }));
  router.post('/discord/tickets-panel', asyncHandler(async (_req, res) => {
    res.json(await publishTicketPanel());
  }));
  router.post('/maps', asyncHandler(async (req, res) => {
    res.json(await setMapPools(req.body));
  }));
  router.post('/discord/sync-roles', asyncHandler(async (_req, res) => {
    const ranks = await syncAllRankRoles();
    const others = await syncTeamAndBadgeRoles();
    // Rôles des équipes (Division) : créés s'ils manquent, effectifs remis à jour.
    const teams = (unwrap(await supabase.from('teams').select('id').is('disbanded_at', null)) ?? []) as { id: string }[];
    if (config.teams.enabled) for (const team of teams) syncTeamRole(team.id);
    res.json({ updated: ranks + others });
  }));

  return router;
}
