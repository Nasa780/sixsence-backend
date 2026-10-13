import { config } from '../config.js';
import type { CodMatch } from '../events.js';
import type { Role } from '../roles.js';
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
 *     - « Staff SixSence » / « Arbitre SixSence » selon le rôle sur le site (message privé de bienvenue) ;
 *     - badges : « Fondateur », « Bêta-testeur », « Partenaire », et « MVP du mois » (dernier MVP).
 *     Ces rôles ne sont ajoutés ou retirés que lors d'un changement fait sur le site.
 *   Annonces
 *     - salon COD : file qui se remplit (avec mention @Player COD), promotions (dès Platine),
 *       top de la semaine (lundi 10 h), MVP du mois, fin de saison ;
 *     - message privé de bienvenue aux nouveaux inscrits ;
 *     - salon GTA : nouvel événement, événement annulé, rappel 1 h avant (avec mention @Player GTA) ;
 *     - message privé aux inscrits 1 h avant un événement GTA.
 */

const RANK_ROLES = [
  { name: 'Légende', min: 3000, color: 0xff6b4a },
  { name: 'Champion', min: 2100, color: 0xe8b4f8 },
  { name: 'Grand Maître', min: 1800, color: 0xc084fc },
  { name: 'Maître', min: 1500, color: 0xa78bfa },
  { name: 'Diamant', min: 1200, color: 0x38bdf8 },
  { name: 'Platine', min: 900, color: 0x34d399 },
  { name: 'Or', min: 600, color: 0xc9a227 },
  { name: 'Argent', min: 300, color: 0x94a3b8 },
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
/** Rôles d'équipe et de badges (ni affichés à part, ni mentionnables). */
const EXTRA_ROLES = [
  { key: 'STAFF', name: 'Staff SixSence', color: 0xd4af37 },
  { key: 'ARBITRE', name: 'Arbitre SixSence', color: 0x60a5fa },
  { key: 'founder', name: 'Fondateur', color: 0xf5d77a },
  { key: 'beta', name: 'Bêta-testeur', color: 0x94a3b8 },
  { key: 'partner', name: 'Partenaire', color: 0xff9a5c },
  { key: 'MVP', name: 'MVP du mois', color: 0xfacc15 },
];
/** Badges du site qui donnent un rôle Discord. */
const BADGE_ROLES = ['founder', 'beta', 'partner'];

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
    ...RANK_ROLES.map((rank) => ({ key: rank.name, name: rank.name, formerNames: [] as string[], color: rank.color, community: false, hoist: true })),
    ...COMMUNITY_ROLES.map((role) => ({ ...role, community: true, hoist: false })),
    ...EXTRA_ROLES.map((role) => ({ ...role, formerNames: [] as string[], community: false, hoist: false })),
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
        body: { name: wanted.name, color: wanted.color, hoist: wanted.hoist, mentionable: wanted.community },
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

/** Ajoute ou retire un rôle géré à un joueur, sans toucher à ses autres rôles. */
async function setRole(userId: string, key: string, on: boolean): Promise<void> {
  if (!discordEnabled) return;
  try {
    const roleId = (await managedRoles()).get(key);
    const discordId = (await discordIds([userId])).get(userId);
    if (!roleId || !discordId) return;
    await discord(`/guilds/${guildId}/members/${discordId}/roles/${roleId}`, { method: on ? 'PUT' : 'DELETE' });
  } catch (error) {
    console.warn(`[discord] rôle « ${key} » impossible`, (error as Error).message);
  }
}

const TEAM_WELCOME: Record<Exclude<Role, 'member'>, string> = {
  arbitre: 'tu es maintenant **arbitre**. Tu tranches les contestations de matchs et les demandes d’arbitrage',
  staff: 'tu fais maintenant partie du **staff**. Tu gères les contestations, les demandes d’arbitrage, les signalements et les sanctions',
  admin: 'tu es maintenant **administrateur**, avec un accès complet',
};

/** Rôle changé dans l'administration : rôles Discord à jour et message privé au joueur. */
export async function onTeamRoleChanged(userId: string, before: Role, after: Role): Promise<void> {
  if (!discordEnabled) return;
  await setRole(userId, 'STAFF', after === 'staff' || after === 'admin');
  await setRole(userId, 'ARBITRE', after === 'arbitre');
  if (before === after) return;
  await dm(
    [userId],
    after === 'member'
      ? '**SixSence** — Ton rôle dans l’équipe SixSence a été retiré. Merci pour ton aide !'
      : `🛡️ **Bienvenue dans l’équipe SixSence** — ${TEAM_WELCOME[after]} depuis l’administration : ${site}/admin`,
  );
}

/** Badges changés dans l'administration : rôles Discord correspondants ajoutés ou retirés. */
export async function onBadgesChanged(userId: string, before: string[], after: string[]): Promise<void> {
  for (const badge of BADGE_ROLES) {
    if (before.includes(badge) !== after.includes(badge)) await setRole(userId, badge, after.includes(badge));
  }
}

/**
 * Rattrapage : rôles d'équipe (staff, arbitre), de badges et « MVP du mois » pour tous les
 * joueurs concernés, sans message privé (au démarrage et depuis l'administration). Ajoute
 * seulement ce que le site indique ; ne retire jamais un rôle posé à la main.
 */
export async function syncTeamAndBadgeRoles(): Promise<number> {
  if (!discordEnabled) return 0;
  let updated = 0;
  try {
    const [{ data: team }, { data: profiles }, { data: mvp }] = await Promise.all([
      supabase.from('users').select('id, role').in('role', ['admin', 'staff', 'arbitre']),
      supabase.from('cod_profiles').select('user_id, badges').overlaps('badges', BADGE_ROLES),
      supabase.from('cod_monthly_mvp').select('user_id').order('month', { ascending: false }).limit(1).maybeSingle(),
    ]);
    for (const member of (team ?? []) as { id: string; role: Role }[]) {
      await setRole(member.id, member.role === 'arbitre' ? 'ARBITRE' : 'STAFF', true);
      updated += 1;
      await pause(250);
    }
    for (const profile of (profiles ?? []) as { user_id: string; badges: string[] }[]) {
      for (const badge of BADGE_ROLES.filter((item) => profile.badges.includes(item))) {
        await setRole(profile.user_id, badge, true);
        await pause(250);
      }
      updated += 1;
    }
    const mvpId = (mvp as { user_id?: string } | null)?.user_id;
    if (mvpId) {
      await setRole(mvpId, 'MVP', true);
      updated += 1;
    }
  } catch (error) {
    console.warn('[discord] rattrapage des rôles d’équipe et de badges impossible', (error as Error).message);
  }
  return updated;
}

/** Nouveau MVP du mois : il prend le rôle, le MVP du mois précédent le rend. */
export async function onMonthlyMvp(userId: string, month: string): Promise<void> {
  await setRole(userId, 'MVP', true);
  const start = new Date(`${month}T12:00:00Z`);
  const previous = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const { data } = await supabase.from('cod_monthly_mvp').select('user_id').eq('month', previous).maybeSingle();
  const former = (data as { user_id?: string } | null)?.user_id;
  if (former && former !== userId) await setRole(former, 'MVP', false);
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

export async function announceNewEvent(event: EventInfo): Promise<void> {
  if (event.status !== 'published') return;
  await Promise.all([
    announce(
      gtaChannelId,
      `🌴 **Nouvel événement GTA 6 : ${event.title}**\n📅 ${eventDate(event.starts_at)}${event.location ? ` · 📍 ${event.location}` : ''}\nInscriptions : ${site}/gta6/events/${event.id}`,
      'GTA',
    ),
    pushToGtaPlayers(event),
  ]);
}

/**
 * Notification « Nouvel événement » aux joueurs GTA : ceux qui se sont déjà inscrits à un
 * événement (et qui ont activé les notifications sur au moins un appareil).
 */
async function pushToGtaPlayers(event: EventInfo): Promise<void> {
  try {
    const { data } = await supabase.from('gta_registrations').select('user_id').limit(5000);
    const userIds = [...new Set(((data ?? []) as { user_id: string }[]).map((row) => row.user_id))];
    await pushToUsers(userIds, {
      title: `🌴 Nouvel événement GTA 6`,
      body: `${event.title} — ${eventDate(event.starts_at)}. Inscris-toi !`,
      url: `/gta6/events/${event.id}`,
      tag: `new-event-${event.id}`,
    });
  } catch (error) {
    console.warn('[push] annonce d’événement impossible', (error as Error).message);
  }
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

// --- Promotions, top de la semaine, bienvenue --------------------------------------------

const PROMOTION_MIN = 900; // annoncées dès Platine (moins de bruit sur les premiers rangs)

/** Après un match : annonce les joueurs qui montent de rang (dès Platine) dans le salon COD. */
export async function announcePromotions(match: CodMatch): Promise<void> {
  if (!discordEnabled || !codChannelId || match.status !== 'completed') return;
  const ids = [...match.team_a, ...match.team_b].filter((id) => (match.points_changes?.[id] ?? 0) > 0);
  if (ids.length === 0) return;
  const [{ data: profiles }, { data: users }] = await Promise.all([
    supabase.from('cod_profiles').select('user_id, points').in('user_id', ids),
    supabase.from('users').select('id, username').in('id', ids),
  ]);
  const names = new Map(((users ?? []) as { id: string; username: string }[]).map((row) => [row.id, row.username]));
  const lines: string[] = [];
  for (const profile of (profiles ?? []) as { user_id: string; points: number }[]) {
    const before = rankRoleFor(profile.points - (match.points_changes?.[profile.user_id] ?? 0));
    const after = rankRoleFor(profile.points);
    const min = RANK_ROLES.find((rank) => rank.name === after)?.min ?? 0;
    if (before !== after && min >= PROMOTION_MIN) lines.push(`🎖️ **${names.get(profile.user_id) ?? 'Un joueur'}** passe **${after}** !`);
  }
  if (lines.length > 0) await announce(codChannelId, `${lines.join('\n')}\n${site}/cod/leaderboard`);
}

const parisPart = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', ...options }).format(date);

/**
 * Top de la semaine : chaque lundi à partir de 10 h (heure de Paris), les 5 joueurs qui ont
 * gagné le plus de points sur les 7 derniers jours. Publié une seule fois (app_claim).
 */
export async function postWeeklyTop(now = new Date()): Promise<void> {
  if (!discordEnabled || !codChannelId) return;
  if (parisPart(now, { weekday: 'short' }) !== 'Mon' || Number(parisPart(now, { hour: '2-digit', hourCycle: 'h23' })) < 10) return;
  const week = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(now);
  const { data: claimed, error } = await supabase.rpc('app_claim', { p_key: 'weekly_top', p_value: week });
  if (error || !claimed) return;

  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString();
  const { data: matches } = await supabase.from('cod_matches').select('points_changes').eq('status', 'completed').gte('completed_at', since).limit(5000);
  const totals = new Map<string, number>();
  for (const match of (matches ?? []) as { points_changes: Record<string, number> | null }[]) {
    for (const [userId, change] of Object.entries(match.points_changes ?? {})) totals.set(userId, (totals.get(userId) ?? 0) + change);
  }
  const top = [...totals.entries()].filter(([, points]) => points > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) return;
  const { data: users } = await supabase.from('users').select('id, username').in('id', top.map(([id]) => id));
  const names = new Map(((users ?? []) as { id: string; username: string }[]).map((row) => [row.id, row.username]));
  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  await announce(
    codChannelId,
    `📈 **Top de la semaine** — points gagnés sur 7 jours\n${top.map(([id, points], index) => `${medals[index]} **${names.get(id) ?? 'Joueur'}** · +${points} pts`).join('\n')}\nClassement : ${site}/cod/leaderboard`,
  );
}

/** Message privé de bienvenue aux nouveaux inscrits (une seule fois, users.welcomed_at). */
export async function welcomeNewPlayers(): Promise<void> {
  if (!discordEnabled) return;
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from('users')
    .update({ welcomed_at: new Date().toISOString() })
    .is('welcomed_at', null)
    .gte('created_at', since)
    .select('id');
  if (error) {
    console.warn('[discord] bienvenue impossible', error.message);
    return;
  }
  const ids = ((data ?? []) as { id: string }[]).map((row) => row.id);
  if (ids.length === 0) return;
  await dm(
    ids,
    `👋 **Bienvenue sur SixSence !**\n` +
      `Pour jouer en classé :\n` +
      `1. Renseigne ton identifiant Activision : ${site}/cod/profile\n` +
      `2. Installe l’application et active les notifications pour être prévenu dès que ton match est trouvé\n` +
      `3. Rejoins la file : ${site}/cod/ranked\n` +
      `Règlement : ${site}/reglement`,
  );
}
