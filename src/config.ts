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
 * Files proposées. COD_FORMATS liste les formats (« 2v2,3v3,4v4,5v5 » par défaut).
 * COD_TEAM_SIZE (ancien réglage de test) ajoute en plus une file « NvN (test) »,
 * par exemple 1v1 pour tester à deux comptes.
 */
function parseFormats(): QueueFormat[] {
  const formats: QueueFormat[] = [];
  for (const raw of list('COD_FORMATS', ['2v2', '3v3', '4v4', '5v5'])) {
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
  /**
   * Mode local sans risque (LOCAL_SAFE=1) : pour essayer le site sur son PC avec la base de production.
   * Aucune tâche du classé (purge de la file au démarrage, ménage des matchs, « Prêt ? », Discord,
   * MVP, cartes, annonces) et file / groupes du classé fermés ; seul le Division tourne.
   */
  localSafe: process.env.LOCAL_SAFE?.trim() === '1',
  supabaseUrl: required('SUPABASE_URL'),
  // SUPABASE_KEY : nom historique de la variable sur Render, accepté pour éviter de la renommer.
  supabaseSecretKey: required('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY'),
  corsOrigins: list('CORS_ORIGINS', DEFAULT_ORIGINS),

  cod: {
    /** Files classées proposées (formats et taille des équipes). */
    formats: parseFormats(),
    maps: list('COD_MAPS', [
      'Exposure',
      'Imprint',
      'The Forge',
      'Toshin',
      'Colossus',
      'Den',
      'Flagship',
      'Homestead',
      'Retrieval',
      'Scar',
      'Express',
      'Hijacked',
      'Raid',
      'Nuketown 2025',
      'Utopia',
      'Standoff',
      'Yakei',
      'Meltdown',
      'Fringe',
      'Sake',
      'Slums',
      'Cliff Town',
      'Grind',
      'Firing Range',
      'Beacon',
      'Plaza',
      'Gridlock',
      'Summit',
      'Hacienda',
      'Ascent',
      'Primetime',
      'Vertigo',
    ]),
    /** Mode du classé : Recherche & Destruction en réglage Hardcore uniquement. */
    modes: list('COD_MODES', ['Recherche & Destruction Hardcore']),
    confirmMinutes: integer('COD_CONFIRM_MINUTES', 15, 1),
    cancelMinutes: integer('COD_CANCEL_MINUTES', 180, 5),
    /** Temps laissé à chaque joueur pour accepter un match trouvé (vérification « Prêt ? »). */
    readySeconds: integer('COD_READY_SECONDS', 60, 10),
    /** Délai de grâce après une déconnexion avant de retirer le joueur de la file. */
    disconnectGraceMs: 30_000,
    /**
     * Sur téléphone, le système coupe la connexion dès que le joueur verrouille l'écran ou
     * change d'appli : il garde sa place plus longtemps et la notification push le prévient.
     */
    mobileGraceMinutes: integer('COD_MOBILE_GRACE_MINUTES', 30, 1),
    /** Durée maximale d'une recherche sans confirmer sa présence (« Toujours là ? » 5 min avant). */
    queueMaxMinutes: integer('COD_QUEUE_MAX_MINUTES', 30, 10),
    queueWarnMinutes: 5,
    /**
     * Groupes (jouer à plusieurs dans la même équipe) : coupés depuis le 2026-10-20, le classé se joue
     * en solo. Code conservé : COD_GROUPS=on les remet (penser aux textes du site et au barème).
     */
    groupsEnabled: process.env.COD_GROUPS?.trim() === 'on',
  },

  /** Division : BO3 entre équipes. TEAM_MATCH_PLAYERS : joueurs par équipe et par match (4 ; moins pour tester). */
  teams: {
    /** Mode en pause tant que TEAM_MODE ne vaut pas « on » : pas de création d'équipe, de match ni de tournoi. */
    enabled: process.env.TEAM_MODE?.trim() === 'on',
    /** TEAM_DISCORD=off : aucun message, salon ni rôle Discord pour les équipes (tests en ligne discrets). */
    discord: process.env.TEAM_DISCORD?.trim() !== 'off',
    rosterSize: integer('TEAM_MATCH_PLAYERS', 4, 1),
    /** Pas deux matchs contre la même équipe dans ce délai (minutes). */
    rematchMinutes: integer('TEAM_REMATCH_MINUTES', 120, 0),
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
    /** Salon privé des alertes d'erreurs (facultatif, sinon le salon de l'équipe). */
    alertsChannelId: process.env.DISCORD_ALERTS_CHANNEL_ID?.trim() || '',
    /** Salon des annonces COD : file qui se remplit, MVP du mois, fin de saison (facultatif). */
    codChannelId: process.env.DISCORD_COD_CHANNEL_ID?.trim() || '',
    /** Salon des annonces GTA 6 : nouveaux événements, rappels (facultatif). */
    gtaChannelId: process.env.DISCORD_GTA_CHANNEL_ID?.trim() || '',
    /** Salon du règlement du serveur (publié par le bot depuis l'admin). */
    rulesChannelId: process.env.DISCORD_RULES_CHANNEL_ID?.trim() || '1561121381578444890',
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
