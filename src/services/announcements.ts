import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { supabase } from '../supabase.js';
import { discord, discordEnabled } from './discord.js';
import { logToDiscord } from './siteLog.js';

/**
 * Annonces illustrées du serveur Discord, chacune dans son salon (announceChannelFor) : annonces et nouveautés dans
 * DISCORD_ANNOUNCE_CHANNEL_ID, coupes et saison dans DISCORD_COD_ANNOUNCE_CHANNEL_ID, événements GTA dans
 * DISCORD_GTA_CHANNEL_ID (à défaut, le salon des annonces) :
 * encadré avec titre, texte, lien et grande image (`/api/og/annonce` du site), et mention du rôle de
 * notification choisi par les membres dans l'Intégration de Discord (questions d'accueil du serveur).
 *
 *   annonce     annonce libre, publiée depuis l'admin
 *   nouveautes  dernière mise à jour du site, publiée depuis l'admin
 *   horus       Coupe Horus : inscriptions ouvertes, vainqueur (rôle 🔔 Annonces)
 *   anubis      Coupe Anubis : inscriptions ouvertes, vainqueurs (rôle 🔔 Annonces)
 *   gta         nouvel événement GTA 6
 *   saison      fin de saison dans 3 jours, saison terminée
 *
 * Chaque type se coupe dans l'admin (app_state « discord_announce_off » : liste des types coupés).
 * Sans salon configuré, rien n'est publié (les messages habituels des salons COD, Division et GTA restent).
 * Les rôles d'Intégration (notifications, plateformes, Membre) sont créés par le bot depuis l'admin.
 */

export const ANNOUNCE_TYPES = ['annonce', 'nouveautes', 'horus', 'anubis', 'gta', 'saison'] as const;
export type AnnounceType = (typeof ANNOUNCE_TYPES)[number];

/** Rôle de notification de chaque type (mentionnable), et couleur de l'encadré. */
const NOTIFY: Record<AnnounceType, { role: string; color: number; label: string }> = {
  annonce: { role: '🔔 Annonces', color: 0xe7c05a, label: 'Annonces' },
  nouveautes: { role: '🔔 Nouveautés', color: 0xe7c05a, label: 'Nouveautés du site' },
  // Coupes : même rôle que les annonces générales (pas de rôle par coupe dans l'Intégration).
  horus: { role: '🔔 Annonces', color: 0xe5484d, label: 'Coupe Horus' },
  anubis: { role: '🔔 Annonces', color: 0xe5484d, label: 'Coupe Anubis' },
  gta: { role: '🔔 Événements GTA', color: 0xff9a5c, label: 'Événements GTA 6' },
  saison: { role: '🔔 Fin de saison', color: 0x34d399, label: 'Fin de saison' },
};
/** Autres rôles proposés dans l'Intégration (jeux : « Player COD » et « Player GTA », déjà gérés par le site). */
const ONBOARDING_ROLES = [
  { name: 'PC', color: 0x94a3b8 },
  { name: 'PlayStation', color: 0x3b82f6 },
  { name: 'Xbox', color: 0x22c55e },
  { name: 'Membre', color: 0xe7c05a },
];

const STATE_KEY = 'discord_announce_off';

/** Salon de chaque type d'annonce (à défaut : le salon des annonces). */
export function announceChannelFor(type: AnnounceType): string {
  const { announceChannelId, codAnnounceChannelId, gtaChannelId } = config.discord;
  if (type === 'horus' || type === 'anubis' || type === 'saison') return codAnnounceChannelId || announceChannelId;
  if (type === 'gta') return gtaChannelId || announceChannelId;
  return announceChannelId;
}
const site = config.siteUrl;

let rolesCache: { ids: Map<string, string>; at: number } | null = null;

/** Identifiants des rôles d'Intégration ; `create` crée ceux qui manquent (droit « Gérer les rôles »). */
async function onboardingRoles(create = false): Promise<Map<string, string>> {
  if (!create && rolesCache && Date.now() - rolesCache.at < 10 * 60_000) return rolesCache.ids;
  const existing = (await discord(`/guilds/${config.discord.guildId}/roles`)) as { id: string; name: string }[];
  const ids = new Map<string, string>();
  const wanted = [
    ...[...new Map(Object.values(NOTIFY).map((item) => [item.role, { name: item.role, color: item.color, mentionable: true }])).values()],
    ...ONBOARDING_ROLES.map((item) => ({ ...item, mentionable: false })),
  ];
  for (const role of wanted) {
    let found = existing.find((item) => item.name.toLowerCase() === role.name.toLowerCase());
    if (!found && create) {
      found = (await discord(`/guilds/${config.discord.guildId}/roles`, { method: 'POST', body: { ...role, hoist: false } })) as { id: string; name: string };
      console.log(`[discord] rôle « ${role.name} » créé`);
    }
    if (found) ids.set(role.name, found.id);
  }
  rolesCache = { ids, at: Date.now() };
  return ids;
}

/** Identifiant du rôle 🔔 d'un type (pour un rappel dans un autre salon), s'il existe. */
export async function notifyRoleId(type: AnnounceType): Promise<string | undefined> {
  if (!discordEnabled) return undefined;
  return (await onboardingRoles().catch(() => new Map<string, string>())).get(NOTIFY[type].role);
}

async function disabledTypes(): Promise<AnnounceType[]> {
  const { data } = await supabase.from('app_state').select('value').eq('key', STATE_KEY).maybeSingle();
  try {
    const list = JSON.parse((data as { value?: string } | null)?.value ?? '[]') as string[];
    return ANNOUNCE_TYPES.filter((type) => list.includes(type));
  } catch {
    return [];
  }
}

/** Adresse de l'image de l'annonce (bandeau 1200 x 630 dessiné par le site). */
function imageUrl(type: AnnounceType, title: string, subtitle?: string): string {
  const params = new URLSearchParams({ type, title: title.slice(0, 90) });
  if (subtitle) params.set('sub', subtitle.slice(0, 120));
  return `${site}/api/og/annonce?${params.toString()}`;
}

export interface Announcement {
  type: AnnounceType;
  title: string;
  text: string;
  /** Lien « En savoir plus » (chemin du site ou adresse complète). */
  url?: string;
  /** Ligne courte sous le titre de l'image (date, format…). */
  subtitle?: string;
  /** Image à la place du bandeau généré (affiche d'une coupe). */
  image?: string;
}

/** Publie une annonce. Au mieux : une erreur Discord est journalisée, jamais remontée (sauf `strict`, pour l'admin). */
export async function postAnnouncement(item: Announcement, strict = false): Promise<boolean> {
  const channel = announceChannelFor(item.type);
  try {
    if (!discordEnabled || !channel) throw new HttpError(409, 'DISCORD_DISABLED', 'Le bot Discord ou le salon de cette annonce n’est pas configuré.');
    if ((await disabledTypes()).includes(item.type)) {
      if (strict) throw new HttpError(409, 'ANNOUNCE_OFF', 'Ce type d’annonce est coupé dans les réglages.');
      return false;
    }
    const roleId = (await onboardingRoles()).get(NOTIFY[item.type].role);
    const link = item.url ? (item.url.startsWith('http') ? item.url : `${site}${item.url}`) : undefined;
    await discord(`/channels/${channel}/messages`, {
      method: 'POST',
      body: {
        content: roleId ? `<@&${roleId}>` : undefined,
        allowed_mentions: { roles: roleId ? [roleId] : [] },
        embeds: [
          {
            title: item.title.slice(0, 250),
            description: `${item.text.slice(0, 3800)}${link ? `\n\n👉 [En savoir plus](${link})` : ''}`,
            url: link,
            color: NOTIFY[item.type].color,
            image: { url: item.image ?? imageUrl(item.type, item.title, item.subtitle) },
            footer: { text: `SixSence · ${NOTIFY[item.type].label}` },
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
    return true;
  } catch (caught) {
    if (strict) throw caught instanceof HttpError ? caught : new HttpError(502, 'DISCORD_ERROR', `Publication impossible : vérifie que le bot peut écrire dans le salon (${(caught as Error).message}).`);
    if (!(caught instanceof HttpError)) console.warn('[discord] annonce illustrée impossible', (caught as Error).message);
    return false;
  }
}

// --- Administration ------------------------------------------------------------------------

/** Réglages des annonces pour l'admin : salon configuré, types coupés, rôles présents sur le serveur. */
export async function announceSettings() {
  const configured = discordEnabled && Boolean(config.discord.announceChannelId);
  let roles: { name: string; exists: boolean }[] = [];
  if (discordEnabled) {
    const ids = await onboardingRoles().catch(() => new Map<string, string>());
    roles = [...new Set([...Object.values(NOTIFY).map((item) => item.role), ...ONBOARDING_ROLES.map((item) => item.name)])].map((name) => ({ name, exists: ids.has(name) }));
  }
  return {
    configured,
    disabled: await disabledTypes(),
    types: ANNOUNCE_TYPES.map((type) => ({ type, label: NOTIFY[type].label, role: NOTIFY[type].role })),
    roles,
  };
}

export async function setDisabledTypes(body: unknown) {
  const list = (body as { disabled?: unknown })?.disabled;
  if (!Array.isArray(list)) throw new HttpError(400, 'INVALID_SETTINGS', 'Liste des annonces coupées attendue.');
  const disabled = ANNOUNCE_TYPES.filter((type) => list.includes(type));
  const { error } = await supabase.from('app_state').upsert({ key: STATE_KEY, value: JSON.stringify(disabled) });
  if (error) throw new HttpError(500, 'DB_ERROR', error.message);
  return announceSettings();
}

/** Crée sur le serveur les rôles d'Intégration qui manquent. */
export async function createOnboardingRoles() {
  if (!discordEnabled) throw new HttpError(409, 'DISCORD_DISABLED', 'Le bot Discord n’est pas configuré.');
  try {
    await onboardingRoles(true);
  } catch (caught) {
    throw new HttpError(502, 'DISCORD_ERROR', `Création impossible : le bot doit avoir le droit « Gérer les rôles » (${(caught as Error).message}).`);
  }
  return announceSettings();
}

/** Annonce publiée à la main depuis l'admin (annonce libre ou nouveautés). */
export async function manualAnnouncement(body: unknown) {
  const input = (body ?? {}) as { type?: unknown; title?: unknown; text?: unknown; url?: unknown };
  const type = input.type === 'nouveautes' ? 'nouveautes' : 'annonce';
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;
  if (title.length < 3 || title.length > 120) throw new HttpError(400, 'INVALID_ANNOUNCE', 'Titre de 3 à 120 caractères.');
  if (text.length < 3 || text.length > 3500) throw new HttpError(400, 'INVALID_ANNOUNCE', 'Texte de 3 à 3 500 caractères.');
  if (url && !/^(https:\/\/|\/)/.test(url)) throw new HttpError(400, 'INVALID_ANNOUNCE', 'Lien : adresse https:// ou chemin du site (/…).');
  await postAnnouncement({ type, title, text, url }, true);
  return { posted: true };
}

// --- Rôle « Membre » pour tous ---------------------------------------------------------------

/**
 * Donne le rôle « Membre » à tous les membres actuels du serveur (hors bots), en tâche de fond : les nouveaux
 * le reçoivent par l'Intégration. Liste des membres : intention « Server Members Intent » à activer dans le
 * portail développeur (Bot). Bilan dans le salon du journal.
 */
let givingMemberRole = false;
export async function giveMemberRoleToAll(): Promise<{ started: boolean }> {
  if (!discordEnabled) throw new HttpError(409, 'DISCORD_DISABLED', 'Le bot Discord n’est pas configuré.');
  if (givingMemberRole) throw new HttpError(409, 'ALREADY_RUNNING', 'Distribution déjà en cours.');
  const roleId = (await onboardingRoles(true)).get('Membre');
  if (!roleId) throw new HttpError(502, 'DISCORD_ERROR', 'Rôle « Membre » introuvable.');
  type Member = { user: { id: string; bot?: boolean }; roles: string[] };
  let first: Member[];
  try {
    first = (await discord(`/guilds/${config.discord.guildId}/members?limit=1000`)) as Member[];
  } catch (caught) {
    throw new HttpError(502, 'DISCORD_ERROR', `Liste des membres refusée : active « Server Members Intent » dans le portail développeur, onglet Bot (${(caught as Error).message}).`);
  }
  givingMemberRole = true;
  void (async () => {
    let given = 0;
    let failed = 0;
    let page = first;
    try {
      while (page.length) {
        for (const member of page) {
          if (member.user.bot || member.roles.includes(roleId)) continue;
          try {
            await discord(`/guilds/${config.discord.guildId}/members/${member.user.id}/roles/${roleId}`, { method: 'PUT' });
            given += 1;
          } catch {
            failed += 1;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (page.length < 1000) break;
        page = (await discord(`/guilds/${config.discord.guildId}/members?limit=1000&after=${page[page.length - 1]!.user.id}`)) as Member[];
      }
    } finally {
      givingMemberRole = false;
      logToDiscord(`👥 Rôle **Membre** donné à **${given}** membre(s)${failed ? ` (${failed} échec(s) : rôle du bot à placer au-dessus de « Membre »)` : ''}.`);
    }
  })();
  return { started: true };
}

// --- Fin de saison : rappel 3 jours avant ------------------------------------------------------

/** Rappel « fin de saison dans 3 jours », une fois par saison (app_claim). Appelé toutes les 15 minutes. */
export async function remindSeasonEnd(now = Date.now()): Promise<void> {
  if (!discordEnabled || !announceChannelFor('saison')) return;
  const { data } = await supabase.from('seasons').select('id, name, ends_at').eq('is_active', true).maybeSingle();
  const season = data as { id: number; name: string; ends_at: string | null } | null;
  if (!season?.ends_at) return;
  const left = new Date(season.ends_at).getTime() - now;
  if (left <= 0 || left > 3 * 24 * 60 * 60_000) return;
  const { data: claimed } = await supabase.rpc('app_claim', { p_key: 'season_end_reminder', p_value: String(season.id) });
  if (!claimed) return;
  const date = new Date(season.ends_at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
  await postAnnouncement({
    type: 'saison',
    title: `${season.name} : dernière ligne droite`,
    subtitle: `Fin ${date}`,
    text: `La saison se termine **${date}**. Derniers jours pour grimper au classement et décrocher les récompenses de fin de saison (champion, top 10, participant). Les transferts d'équipe sont verrouillés jusqu'à la clôture.`,
    url: '/cod/leaderboard',
  });
}
