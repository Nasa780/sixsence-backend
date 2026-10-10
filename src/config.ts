/**
 * Configuration du backend, lue une seule fois au démarrage depuis les
 * variables d'environnement. Voir .env.example pour la liste commentée.
 */

function required(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Variable d'environnement manquante : ${names.join(' ou ')} (voir .env.example)`);
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function integer(name: string, fallback: number, min: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/** Origines du site autorisées par défaut (production, aperçus Vercel, local). */
const DEFAULT_ORIGINS = [
  'https://sixsence.fr',
  'https://www.sixsence.fr',
  'https://sixsence-frontend.vercel.app',
  'https://sixsence-frontend-*.vercel.app',
  'http://localhost:3000',
];

export const config = {
  port: integer('PORT', 4000, 1),
  supabaseUrl: required('SUPABASE_URL'),
  // SUPABASE_KEY : nom historique de la variable sur Render, accepté pour éviter de la renommer.
  supabaseSecretKey: required('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY'),
  corsOrigins: list('CORS_ORIGINS', DEFAULT_ORIGINS),

  cod: {
    /** Joueurs par équipe. 5 => un match démarre dès que 10 joueurs sont en file. */
    teamSize: integer('COD_TEAM_SIZE', 5, 1),
    maps: list('COD_MAPS', [
      'Babylon',
      'Derelict',
      'Lowtown',
      'Payback',
      'Protocol',
      'Red Card',
      'Rewind',
      'Skyline',
      'Subsonic',
      'Vault',
      'Vorkuta',
    ]),
    modes: list('COD_MODES', ['Recherche & Destruction']),
    confirmMinutes: integer('COD_CONFIRM_MINUTES', 15, 1),
    cancelMinutes: integer('COD_CANCEL_MINUTES', 180, 5),
    /** Délai de grâce après une déconnexion avant de retirer le joueur de la file. */
    disconnectGraceMs: 30_000,
  },
} as const;

/** Nombre de joueurs nécessaires pour lancer un match. */
export const playersNeeded = config.cod.teamSize * 2;

/**
 * Vérifie qu'une origine (en-tête Origin du navigateur) fait partie de la liste
 * autorisée. Le joker * est accepté, par exemple https://*.vercel.app.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  // Pas d'en-tête Origin : appel serveur à serveur (bot Discord, curl, sonde Render).
  // L'accès reste protégé par le jeton, l'origine n'est qu'une barrière de plus.
  if (!origin) return true;
  return config.corsOrigins.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.includes('*')) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+');
    return new RegExp(`^${escaped}$`).test(origin);
  });
}
