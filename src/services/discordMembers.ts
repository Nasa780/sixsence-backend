import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { discord } from './discord.js';
import { diffMembers, goodbyeText, welcomeImageUrl, welcomeText, type GuildMember, type KnownMember } from './discordMembersPolicy.js';
import { logToDiscord } from './siteLog.js';

/**
 * Arrivées et départs du serveur Discord (événements de services/discordGateway.ts).
 * Table discord_members : chaque annonce est « réservée » par une écriture atomique, donc jamais envoyée deux fois,
 * même pendant un redéploiement où deux instances écoutent. Après une coupure, syncMembers rattrape ce qui a été manqué.
 */

const { guildId, welcomeChannelId, goodbyeChannelId, rulesChannelId } = config.discord;

/** Salons renseignés : sans eux, aucune connexion permanente et DraftBot reste seul. */
export const memberMessagesEnabled = Boolean(welcomeChannelId && goodbyeChannelId);

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

export interface MemberEvent {
  user: DiscordUser;
  nick?: string | null;
  joined_at?: string;
}

const nameOf = (member: MemberEvent) => member.nick || member.user.global_name || member.user.username || null;

async function sendWelcome(member: MemberEvent): Promise<void> {
  const { id, avatar } = member.user;
  await discord(`/channels/${welcomeChannelId}/messages`, {
    method: 'POST',
    body: {
      content: welcomeText(id, rulesChannelId, config.siteUrl),
      embeds: [{ color: 0xd4af37, image: { url: welcomeImageUrl(config.siteUrl, id, avatar, nameOf(member)) } }],
      allowed_mentions: { users: [id] },
    },
  });
}

/** Réserve une arrivée : vrai pour la seule instance qui doit l'annoncer. */
async function claimArrival(id: string, username: string | null, joinedAt: string): Promise<boolean> {
  const row = { user_id: id, username, present: true, joined_at: joinedAt, left_at: null };
  const { data: inserted, error } = await supabase.from('discord_members').upsert(row, { onConflict: 'user_id', ignoreDuplicates: true }).select('user_id');
  if (error) throw new Error(error.message);
  if (inserted?.length) return true;
  const { data: back, error: updateError } = await supabase.from('discord_members').update(row).eq('user_id', id).eq('present', false).select('user_id');
  if (updateError) throw new Error(updateError.message);
  return Boolean(back?.length);
}

/** Réserve un départ ; renvoie le pseudo enregistré si cette instance doit l'annoncer. */
async function claimDeparture(id: string): Promise<{ username: string | null } | null> {
  const { data, error } = await supabase.from('discord_members').update({ present: false, left_at: new Date().toISOString() }).eq('user_id', id).eq('present', true).select('username');
  if (error) throw new Error(error.message);
  return (data?.[0] as { username: string | null } | undefined) ?? null;
}

export async function onMemberAdd(member: MemberEvent): Promise<void> {
  if (member.user.bot) return;
  if (await claimArrival(member.user.id, nameOf(member), member.joined_at ?? new Date().toISOString())) await sendWelcome(member);
}

export async function onMemberRemove(user: DiscordUser): Promise<void> {
  if (user.bot) return;
  const claimed = await claimDeparture(user.id);
  if (claimed) await discord(`/channels/${goodbyeChannelId}/messages`, { method: 'POST', body: { content: goodbyeText(user.global_name || claimed.username || user.username) } });
}

async function allMembers(): Promise<MemberEvent[]> {
  const members: MemberEvent[] = [];
  let after = '0';
  for (;;) {
    const page = (await discord(`/guilds/${guildId}/members?limit=1000&after=${after}`)) as MemberEvent[];
    members.push(...page.filter((member) => !member.user.bot));
    if (page.length < 1000) return members;
    after = page[page.length - 1]!.user.id;
  }
}

async function knownMembers(): Promise<KnownMember[]> {
  const known: KnownMember[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('discord_members').select('user_id, present').range(from, from + 999);
    if (error) throw new Error(error.message);
    known.push(...((data ?? []) as { user_id: string; present: boolean }[]).map((row) => ({ id: row.user_id, present: row.present })));
    if (!data || data.length < 1000) return known;
  }
}

/** À chaque connexion : la première fois, enregistre les membres sans message ; ensuite, rattrape les arrivées et départs manqués. */
export async function syncMembers(now = Date.now()): Promise<void> {
  const [members, known] = await Promise.all([allMembers(), knownMembers()]);
  const byId = new Map(members.map((member) => [member.user.id, member]));
  const joinedAt = (member: MemberEvent) => member.joined_at ?? new Date(now).toISOString();

  if (known.length === 0) {
    const rows = members.map((member) => ({ user_id: member.user.id, username: nameOf(member), present: true, joined_at: joinedAt(member) }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('discord_members').upsert(rows.slice(i, i + 500), { onConflict: 'user_id', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    }
    console.log(`[discord] ${rows.length} membre(s) enregistré(s), sans message`);
    return;
  }

  const current: GuildMember[] = members.map((member) => ({ id: member.user.id, joinedAt: new Date(joinedAt(member)).getTime() }));
  const diff = diffMembers(known, current, now);
  if (diff.suspicious) {
    logToDiscord('👥 Arrivées et départs : liste des membres incomplète, rattrapage ignoré.');
    return;
  }
  for (const { id } of diff.silent) {
    const member = byId.get(id)!;
    await claimArrival(id, nameOf(member), joinedAt(member));
  }
  for (const { id } of diff.welcome) {
    const member = byId.get(id)!;
    await onMemberAdd(member).catch((error) => console.warn('[discord] bienvenue manquée', (error as Error).message));
  }
  for (const id of diff.departed) await onMemberRemove({ id }).catch((error) => console.warn('[discord] départ manqué', (error as Error).message));
}
