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

/** Une file classée : « 2v2 », « 5v5 »… (teamSize joueurs par équipe). */
export interface QueueFormat {
  id: string;
  teamSize: number;
  label: string;
}

/**
 * Files proposées. COD_FORMATS liste les formats (« 2v2,5v5 » par défaut).
 * COD_TEAM_SIZE (ancien réglage de test) ajoute en plus une file « NvN (test) »,
 * par exemple 1v1 pour tester à deux comptes.
 */
function parseFormats(): QueueFormat[] {
  const formats: QueueFormat[] = [];
  for (const raw of list('COD_FORMATS', ['2v2', '5v5'])) {
    const match = /^([1-5])v\1$/.exec(raw);
    if (match && !formats.some((format) => format.id === raw)) {
      formats.push({ id: raw, teamSize: Number(match[1]), label: raw });
    }
  }
  const testSize = Number.parseInt(process.env.COD_TEAM_SIZE ?? '', 10);
  const testId = `${testSize}v${testSize}`;
  if (testSize >= 1 && testSize <= 5 && !formats.some((format) => format.id === testId)) {
    formats.unshift({ id: testId, teamSize: testSize, label: `${testId} (test)` });
  }
  return formats.length > 0 ? formats : [{ id: '5v5', teamSize: 5, label: '5v5' }];
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
    /** Files classées proposées (formats et taille des équipes). */
    formats: parseFormats(),
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
    /** Temps laissé à chaque joueur pour accepter un match trouvé (vérification « Prêt ? »). */
    readySeconds: integer('COD_READY_SECONDS', 60, 10),
    /** Délai de grâce après une déconnexion avant de retirer le joueur de la file. */
    disconnectGraceMs: 30_000,
  },

  /**
   * Intégration Discord (facultative : désactivée tant que DISCORD_BOT_TOKEN est vide).
   * Le bot doit être membre du serveur DISCORD_GUILD_ID avec les droits « Gérer les salons »
   * et « Envoyer des messages ».
   */
  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN?.trim() || '',
    guildId: process.env.DISCORD_GUILD_ID?.trim() || '',
    /** Catégorie où créer les salons vocaux des matchs (facultatif). */
    matchCategoryId: process.env.DISCORD_MATCH_CATEGORY_ID?.trim() || '',
    /** Salon où publier les résultats (facultatif). */
    resultsChannelId: process.env.DISCORD_RESULTS_CHANNEL_ID?.trim() || '',
    /** Salon privé de l'équipe : demandes d'arbitrage et signalements (facultatif). */
    staffChannelId: process.env.DISCORD_STAFF_CHANNEL_ID?.trim() || '',
  },

  /** Adresse publique du site (liens envoyés sur Discord). */
  siteUrl: (process.env.SITE_URL?.trim() || 'https://www.sixsence.fr').replace(/\/$/, ''),
} as const;

/** Format de file par identifiant (« 2v2 »), ou undefined s'il n'existe pas. */
export function findFormat(id: unknown): QueueFormat | undefined {
  return typeof id === 'string' ? config.cod.formats.find((format) => format.id === id) : undefined;
}

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
