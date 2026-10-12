import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { SUPPRESS_EMBEDS, discord, discordEnabled, discordIds, dm } from './discord.js';
import { pushToUsers } from './push.js';
import { queueLevel, shouldAnnounce } from './announcePolicy.js';
import type { QueueSummary } from './queue.js';

/**
 * Vie du serveur Discord (tout est facultatif et « au mieux » : une erreur Discord est
 * journalisée mais ne bloque jamais le site).
 *
 *   Rôles automatiques
 *     - un rôle par rang (Bronze … Champion), tenu à jour après chaque match ;
 *     - « Player COD » dès le premier match classé, « Player GTA » dès la première inscription à un événement.
 *     Les rôles manquants sont créés par le bot (droit « Gérer les rôles » requis ; le rôle
 *     du bot doit être placé au-dessus de ces rôles dans la liste des rôles du serveur).
 *   Annonces
 *     - salon COD : file qui se remplit (avec mention @Player COD), MVP du mois, fin de saison ;
 *     - salon GTA : nouvel événement, événement annulé, rappel 1 h avant (avec mention @Player GTA) ;
 *     - message privé aux inscrits 1 h avant un événement GTA.
 */

const RANK_ROLES = [
  { name: 'Champion', min: 3500, color: 0xe8b4f8 },
  { name: 'Grand Maître', min: 3000, color: 0xc084fc },
  { name: 'Maître', min: 2500, color: 0xa78bfa },
  { name: 'Diamant', min: 2000, color: 0x38bdf8 },
  { name: 'Platine', min: 1500, color: 0x34d399 },
  { name: 'Or', min: 1000, color: 0xc9a227 },
  { name: 'Argent', min: 500, color: 0x94a3b8 },
  { name: 'Bronze', min: 0, color: 0xc97b4b },
];
/**
 * Rôles de communauté : `key` est le nom utilisé dans le code, `name` celui affiché
 * sur Discord ; `formerNames` sont d'anciens noms, renommés automatiquement.
 */
const COMMUNITY_ROLES = [
  { key: 'COD', name: 'Player COD', formerNames: ['COD'], color: 0xd4af37 },
  { key: 'GTA', name: 'Player GTA', formerNames: ['GTA'], color: 0xff9a5c },
];

const { guildId, codChannelId, gtaChannelId } = config.discord;
const site = config.siteUrl;

// --- Rôles --------------------------------------------------------------------------

let rolesCache: { ids: Map<string, string>; at: number } | null = null;

/** Identifiants des rôles gérés par le site (créés s'ils n'existent pas). */
async function managedRoles(): Promise<Map<string, string>> {
  if (rolesCache && Date.now() - rolesCache.at < 10 * 60_000) return rolesCache.ids;
  const existing = (await discord(`/guilds/${guildId}/roles`)) as { id: string; name: string }[];
  const ids = new Map<string, string>();
  const byName = (name: string) => existing.find((item) => item.name.toLowerCase() === name.toLowerCase());
  const wantedRoles = [
    ...RANK_ROLES.map((rank) => ({ key: rank.name, name: rank.name, formerNames: [] as string[], color: rank.color, community: false })),
    ...COMMUNITY_ROLES.map((role) => ({ ...role, community: true })),
  ];
  for (const wanted of wantedRoles) {
    let role = byName(wanted.name);
    // Ancien nom (ex. « COD » devenu « Player COD ») : on renomme le rôle, les joueurs le gardent.
    const former = role ? undefined : wanted.formerNames.map(byName).find(Boolean);
    if (former) {
      role = (await discord(`/guilds/${guildId}/roles/${former.id}`, { method: 'PATCH', body: { name: wanted.name } })) as { id: string; name: string };
      console.log(`[discord] rôle « ${former.name} » renommé en « ${wanted.name} »`);
    }
    if (!role) {
      role = (await discord(`/guilds/${guildId}/roles`, {
        method: 'POST',
        // Les rôles de communauté sont mentionnables : les annonces peuvent les prévenir.
        body: { name: wanted.name, color: wanted.color, hoist: !wanted.community, mentionable: wanted.community },
      })) as { id: string; name: string };
      console.log(`[discord] rôle « ${wanted.name} » créé`);
    }
    ids.set(wanted.key, role.id);
  }
  rolesCache = { ids, at: Date.now() };
  return ids;
}

const rankRoleFor = (points: number) => (RANK_ROLES.find((rank) => points >= rank.min) ?? RANK_ROLES[RANK_ROLES.length - 1])!.name;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Applique les rôles voulus à un membre (retire les autres rôles de rang). */
async function applyRoles(discordId: string, wanted: string[], roles: Map<string, string>): Promise<void> {
  let member: { roles: string[] };
  try {
    member = (await discord(`/guilds/${guildId}/members/${discordId}`)) as { roles: string[] };
  } catch {
    return; // pas (ou plus) membre du serveur
  }
  const rankIds = new Set(RANK_ROLES.map((rank) => roles.get(rank.name)));
  const wantedIds = new Set(wanted.map((name) => roles.get(name)).filter(Boolean) as string[]);
  for (const roleId of wantedIds) {
    if (!member.roles.includes(roleId)) {
      await discord(`/guilds/${guildId}/members/${discordId}/roles/${roleId}`, { method: 'PUT' });
      await pause(250);
    }
  }
  for (const roleId of member.roles) {
    if (rankIds.has(roleId) && !wantedIds.has(roleId)) {
      await discord(`/guilds/${guildId}/members/${discordId}/roles/${roleId}`, { method: 'DELETE' });
      await pause(250);
    }
  }
}

/**
 * Met à jour les rôles de rang (et COD) des joueurs donnés : seuls ceux qui ont
 * joué au moins un match classé reçoivent un rang.
 */
export async function syncRankRoles(userIds: string[]): Promise<number> {
  if (!discordEnabled || userIds.length === 0) return 0;
  let updated = 0;
  try {
    const roles = await managedRoles();
    const ids = await discordIds(userIds);
    const { data } = await supabase.from('cod_profiles').select('user_id, points, wins, losses').in('user_id', userIds);
    for (const profile of (data ?? []) as { user_id: string; points: number; wins: number; losses: number }[]) {
      const discordId = ids.get(profile.user_id);
      if (!discordId || profile.wins + profile.losses === 0) continue;
      try {
        await applyRoles(discordId, [rankRoleFor(profile.points), 'COD'], roles);
        updated += 1;
      } catch (error) {
        console.warn('[discord] rôles impossibles pour un joueur', (error as Error).message);
      }
    }
  } catch (error) {
    console.warn('[discord] synchronisation des rôles impossible', (error as Error).message);
  }
  return updated;
}

/** Tous les joueurs classés (au démarrage, ou à la demande depuis l'administration). */
export async function syncAllRankRoles(): Promise<number> {
  if (!discordEnabled) return 0;
  const { data } = await supabase.from('cod_profiles').select('user_id').or('wins.gt.0,losses.gt.0').limit(2000);
  return syncRankRoles(((data ?? []) as { user_id: string }[]).map((row) => row.user_id));
}

/** Donne le rôle « Player GTA » (inscription à un événement). */
export async function giveGtaRole(userId: string): Promise<void> {
  if (!discordEnabled) return;
  try {
    const roles = await managedRoles();
    const discordId = (await discordIds([userId])).get(userId);
    const roleId = roles.get('GTA');
    if (!discordId || !roleId) return;
    await discord(`/guilds/${guildId}/members/${discordId}/roles/${roleId}`, { method: 'PUT' }).catch(() => undefined);
  } catch (error) {
    console.warn('[discord] rôle GTA impossible', (error as Error).message);
  }
}

// --- Annonces ---------------------------------------------------------------------------

async function announce(channelId: string, content: string, mentionRole?: 'COD' | 'GTA'): Promise<void> {
  if (!discordEnabled || !channelId) return;
  try {
    const roleId = mentionRole ? (await managedRoles()).get(mentionRole) : undefined;
    await discord(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: {
        content: roleId ? `<@&${roleId}> ${content}` : content,
        allowed_mentions: { roles: roleId ? [roleId] : [] },
        flags: SUPPRESS_EMBEDS,
      },
    });
  } catch (error) {
    console.warn('[discord] annonce impossible', (error as Error).message);
  }
}

/**
 * File qui se remplit : une annonce quand la moitié des places est prise, une autre
 * quand il ne manque plus qu'un joueur. Au plus une annonce par palier, et au moins
 * 10 minutes entre deux annonces d'une même file (anti-spam). Les files de test sont ignorées.
 */
const queueAnnounced = new Map<string, { level: number; at: number }>();

export function onQueueChanged(queues: QueueSummary[]): void {
  if (!discordEnabled || !codChannelId) return;
  for (const queue of queues) {
    if (queue.label.includes('test')) continue;
    if (!shouldAnnounce(queueAnnounced, queue.format, queueLevel(queue.size, queue.needed))) continue;
    const missing = queue.needed - queue.size;
    void announce(
      codChannelId,
      `🔥 **File ${queue.label}** : ${queue.size}/${queue.needed} joueurs — ${missing === 1 ? 'plus qu’**une place** !' : `il manque **${missing} joueurs**.`} Viens jouer : ${site}/cod/ranked`,
      'COD',
    );
  }
}

export function announceMonthlyMvp(username: string, month: string): Promise<void> {
  const label = new Date(`${month}T12:00:00Z`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return announce(codChannelId, `⭐ **MVP du mois de ${label}** : bravo à **${username}**, le joueur le plus élu MVP ! ${site}/cod/leaderboard`);
}

export function announceSeasonClosed(archived: number, nextName: string): Promise<void> {
  return announce(
    codChannelId,
    `🏆 **Fin de saison** : ${archived} joueurs classés, le classement final est archivé. **${nextName}** commence maintenant, les points repartent de zéro ! ${site}/cod/leaderboard`,
    'COD',
  );
}

interface EventInfo {
  id: string;
  title: string;
  starts_at: string;
  location: string | null;
  status: string;
}

const eventDate = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

export function announceNewEvent(event: EventInfo): Promise<void> {
  if (event.status !== 'published') return Promise.resolve();
  return announce(
    gtaChannelId,
    `🌴 **Nouvel événement GTA 6 : ${event.title}**\n📅 ${eventDate(event.starts_at)}${event.location ? ` · 📍 ${event.location}` : ''}\nInscriptions : ${site}/gta6/events/${event.id}`,
    'GTA',
  );
}

export function announceEventCancelled(event: EventInfo): Promise<void> {
  return announce(gtaChannelId, `❌ **Événement annulé : ${event.title}** (${eventDate(event.starts_at)}).`);
}

/**
 * Rappels 1 h avant chaque événement GTA publié : message privé à chaque inscrit et
 * annonce dans le salon GTA. Appelé toutes les 5 minutes ; chaque rappel n'est envoyé
 * qu'une fois (colonne reminder_sent_at).
 */
export async function sendEventReminders(): Promise<void> {
  const now = Date.now();
  const { data, error } = await supabase
    .from('gta_events')
    .select('id, title, starts_at, location, status')
    .eq('status', 'published')
    .is('reminder_sent_at', null)
    .gt('starts_at', new Date(now).toISOString())
    .lte('starts_at', new Date(now + 65 * 60_000).toISOString());
  if (error || !data) return;

  for (const event of data as EventInfo[]) {
    // On marque d'abord : en cas de redémarrage, un rappel n'est jamais envoyé deux fois.
    const { data: claimed } = await supabase
      .from('gta_events')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', event.id)
      .is('reminder_sent_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) continue;

    const { data: registrations } = await supabase.from('gta_registrations').select('user_id').eq('event_id', event.id);
    const userIds = ((registrations ?? []) as { user_id: string }[]).map((row) => row.user_id);
    const minutes = Math.max(1, Math.round((new Date(event.starts_at).getTime() - now) / 60_000));
    await pushToUsers(userIds, {
      title: `⏰ ${event.title}`,
      body: `Commence dans ${minutes} min. Tu es inscrit.`,
      url: `/gta6/events/${event.id}`,
      tag: `event-${event.id}`,
    });
    if (!discordEnabled) continue;
    await dm(
      userIds,
      `⏰ **${event.title}** commence dans ${minutes} min (${eventDate(event.starts_at)})${event.location ? ` · 📍 ${event.location}` : ''}.\nTu es inscrit : ${site}/gta6/events/${event.id}`,
    );
    await announce(gtaChannelId, `⏰ **${event.title}** commence dans ${minutes} min ! ${userIds.length} inscrit(s). ${site}/gta6/events/${event.id}`, 'GTA');
  }
}
