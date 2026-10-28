import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Erreur métier renvoyée telle quelle au client : { error: { code, message } }. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Les fonctions SQL lèvent des exceptions dont le message est un code
 * (ex. EVENT_FULL). On le traduit ici en statut HTTP et en message lisible.
 */
const DB_ERRORS: Record<string, [status: number, message: string]> = {
  PROFILE_INCOMPLETE: [409, 'Renseigne ton identifiant Activision dans ton profil avant de rejoindre la file.'],
  ALREADY_IN_MATCH: [409, 'Tu as déjà un match en cours.'],
  MATCH_NOT_FOUND: [404, 'Match introuvable.'],
  NOT_A_PLAYER: [403, 'Tu ne participes pas à ce match.'],
  MATCH_NOT_REPORTABLE: [409, 'Le résultat de ce match a déjà été déclaré.'],
  MATCH_NOT_CONFIRMABLE: [409, "Ce match n'attend pas de confirmation."],
  SAME_TEAM_AS_REPORTER: [403, "La confirmation doit venir de l'équipe adverse."],
  MATCH_CLOSED: [409, 'Ce match est déjà clôturé.'],
  CANCEL_VOTE_CLOSED: [409, "Le vote d'annulation est fermé : le match n'est plus en cours."],
  CANCEL_VOTE_TOO_EARLY: [409, "Le vote d'annulation s'ouvre 15 min après le début du match."],
  INVALID_WINNER: [400, 'Vainqueur invalide.'],
  INVALID_MESSAGE: [400, 'Le message doit contenir entre 1 et 300 caractères.'],
  QUEUE_BANNED: [403, 'Tu es temporairement exclu de la file après des matchs non acceptés.'],
  READY_CHECK_CLOSED: [409, 'La vérification de ce match est terminée.'],
  INVALID_PROOF: [400, 'Fichier de preuve invalide.'],
  TOO_MANY_PROOFS: [409, 'Tu as déjà envoyé 5 preuves pour ce match.'],
  MATCHES_IN_PROGRESS: [409, 'Des matchs sont encore en cours : termine-les ou annule-les avant de clôturer la saison.'],
  INVALID_SEASON_NAME: [400, 'Le nom de la saison doit contenir entre 2 et 40 caractères.'],
  NO_ACTIVE_SEASON: [409, 'Aucune saison active.'],
  EVENT_NOT_FOUND: [404, 'Événement introuvable.'],
  EVENT_CLOSED: [409, 'Les inscriptions sont closes pour cet événement.'],
  EVENT_FULL: [409, 'Cet événement est complet.'],
  INVALID_MVP: [400, "Le MVP se choisit parmi les joueurs de l'équipe gagnante."],
  MVP_VOTE_CLOSED: [409, 'Le vote du MVP est fermé pour ce match (24 h après la fin).'],
  // Correction d'un match terminé
  INVALID_ACTION: [400, 'Correction inconnue.'],
  MATCH_NOT_COMPLETED: [409, 'Seul un match terminé avec un vainqueur peut être corrigé.'],
  CORRECTION_TOO_LATE: [409, 'Le délai de correction (48 h après la validation) est dépassé : demande à un admin.'],
  // Sanctions
  INVALID_SANCTION: [400, 'Type de sanction inconnu.'],
  INVALID_REASON: [400, 'Indique un motif (500 caractères au plus).'],
  INVALID_DURATION: [400, "Durée d'exclusion invalide (1 minute à 1 an)."],
  INVALID_POINTS: [400, 'Nombre de points invalide (1 à 5 000).'],
  PLAYER_NOT_FOUND: [404, 'Joueur introuvable.'],
  SANCTION_NOT_FOUND: [404, 'Sanction introuvable.'],
  SANCTION_LIFTED: [409, 'Cette sanction est déjà levée.'],
  // Files et groupes ({detail} = pseudo du joueur concerné)
  INVALID_FORMAT: [400, 'Format de file inconnu.'],
  INVALID_GROUP_SIZE: [400, 'Ton groupe est trop grand pour ce format.'],
  PARTY_CHANGED: [409, 'Ton groupe vient de changer : réessaie.'],
  MEMBER_PROFILE_INCOMPLETE: [409, "{detail} doit renseigner son identifiant Activision avant que le groupe puisse rejoindre la file."],
  MEMBER_BANNED: [403, '{detail} est temporairement exclu de la file : le groupe ne peut pas la rejoindre.'],
  MEMBER_IN_MATCH: [409, '{detail} a déjà un match en cours.'],
  MEMBER_IN_QUEUE: [409, '{detail} est déjà dans une file.'],
  // Équipes (Division)
  ALREADY_IN_TEAM: [409, 'Ce joueur fait déjà partie d’une équipe.'],
  TEAM_NAME_TAKEN: [409, 'Ce nom d’équipe est déjà pris.'],
  TEAM_TAG_TAKEN: [409, 'Ce tag est déjà pris.'],
  TEAM_NOT_FOUND: [404, 'Équipe introuvable.'],
  TEAM_FULL: [409, 'L’équipe est complète (8 joueurs).'],
  NOT_IN_TEAM: [404, 'Ce joueur ne fait pas partie de l’équipe.'],
  OWNER_MUST_TRANSFER: [409, 'Transmets la couronne à un autre membre avant de quitter l’équipe (ou dissous-la).'],
  NOT_TEAM_OWNER: [403, 'Seul le Leader à la couronne peut faire cela.'],
  STARTERS_FULL: [409, 'L’équipe a déjà 4 titulaires : passe d’abord un titulaire en remplaçant.'],
  TOURNAMENT_MATCH: [409, 'Un match de tournoi ne se corrige pas ici : l’admin désigne le vainqueur depuis l’onglet Tournoi.'],
};

export function fromDbError(error: { message: string; details?: string | null }): HttpError {
  const known = DB_ERRORS[error.message];
  if (known) return new HttpError(known[0], error.message, known[1].replace('{detail}', error.details || 'Un joueur'));
  console.error('[db]', error);
  return new HttpError(500, 'INTERNAL_ERROR', 'Erreur interne. Réessaie dans un instant.');
}

/** Renvoie les données d'une réponse Supabase, ou lève l'erreur traduite. */
export function unwrap<T>(result: { data: T | null; error: { message: string; details?: string | null } | null }): T {
  if (result.error) throw fromDbError(result.error);
  return result.data as T;
}

/** Express 4 ne capture pas les rejets de promesse : ce wrapper les transmet à next(). */
export function asyncHandler(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valide un paramètre d'URL censé être un UUID (évite d'envoyer n'importe quoi à Postgres). */
export function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (!value || !UUID_PATTERN.test(value)) {
    throw new HttpError(400, 'INVALID_ID', 'Identifiant invalide.');
  }
  return value;
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route inconnue.' } });
}

// Les 4 paramètres sont obligatoires : c'est ainsi qu'Express reconnaît un gestionnaire d'erreur.
/** Vrai pour une erreur imprévue (500) : ni erreur métier, ni requête invalide. */
export function isUnexpected(error: unknown): boolean {
  if (error instanceof HttpError) return false;
  const status = (error as { status?: number } | null)?.status;
  return status !== 400 && status !== 413;
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  // Corps JSON illisible ou trop volumineux (levé par express.json).
  const status = (error as { status?: number } | null)?.status;
  if (status === 400 || status === 413) {
    res.status(status).json({ error: { code: 'BAD_REQUEST', message: 'Requête invalide.' } });
    return;
  }
  console.error('[http]', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erreur interne. Réessaie dans un instant.' } });
}
