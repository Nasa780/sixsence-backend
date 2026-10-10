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
  INVALID_WINNER: [400, 'Vainqueur invalide.'],
  INVALID_MESSAGE: [400, 'Le message doit contenir entre 1 et 300 caractères.'],
  EVENT_NOT_FOUND: [404, 'Événement introuvable.'],
  EVENT_CLOSED: [409, 'Les inscriptions sont closes pour cet événement.'],
  EVENT_FULL: [409, 'Cet événement est complet.'],
};

export function fromDbError(error: { message: string }): HttpError {
  const known = DB_ERRORS[error.message];
  if (known) return new HttpError(known[0], error.message, known[1]);
  console.error('[db]', error);
  return new HttpError(500, 'INTERNAL_ERROR', 'Erreur interne. Réessaie dans un instant.');
}

/** Renvoie les données d'une réponse Supabase, ou lève l'erreur traduite. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
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
