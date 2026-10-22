import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { supabase } from '../supabase.js';
import { discord, discordEnabled } from './discord.js';
import { logToDiscord } from './siteLog.js';

/**
 * Tickets Discord : un panneau (salon DISCORD_TICKETS_CHANNEL_ID, publié depuis l'admin) avec un bouton
 * par motif (« Autre » : motif écrit par le membre) ; le membre décrit sa demande dans une fenêtre, le bot crée un salon privé « ticket-0042-pseudo »
 * (catégorie DISCORD_TICKETS_CATEGORY_ID facultative) visible du membre, de « Staff 6 » et, pour une
 * contestation, d'« Arbitre 6 ». Un ticket ouvert par membre (table privée discord_tickets, migration 0043).
 *
 * Fermeture (bouton « Fermer », par le membre ou l'équipe) : transcription envoyée dans le salon du journal
 * (DISCORD_LOGS_CHANNEL_ID, sinon staff), salon renommé « fermé-0042 » et en lecture seule pour le membre.
 * Le salon n'est supprimé que si l'équipe clique sur « Supprimer le salon » (après la transcription).
 *
 * Les interactions arrivent par POST /discord/interactions (services/discordCommands.ts).
 */

export const TICKET_MOTIFS = {
  contestation: { label: 'Contestation', emoji: '⚖️', style: 4, color: 0xe5484d, hint: 'Un résultat, une sanction ou une décision à contester.' },
  question: { label: 'Question', emoji: '❓', style: 1, color: 0xd4af37, hint: 'Une question sur le site, le classé, la Division ou les trophées.' },
  signalement: { label: 'Signalement', emoji: '🚩', style: 2, color: 0xf59e0b, hint: 'Un joueur, une triche ou un comportement à signaler.' },
  bug: { label: 'Bug', emoji: '🐞', style: 2, color: 0x60a5fa, hint: 'Un problème sur le site ou avec le bot.' },
  autre: { label: 'Autre', emoji: '✏️', style: 2, color: 0x94a3b8, hint: 'Autre chose : écris ton motif.' },
} as const;
export type TicketMotif = keyof typeof TICKET_MOTIFS;
const isMotif = (value: string): value is TicketMotif => value in TICKET_MOTIFS;

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 1 << 6;
const GOLD = 0xd4af37;
const PANEL_KEY = 'discord_tickets_panel';
// Permissions Discord (champ binaire)
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const MANAGE_MESSAGES = 1n << 13n;
const EMBED = 1n << 14n;
const ATTACH = 1n << 15n;
const HISTORY = 1n << 16n;
const MANAGE_CHANNELS = 1n << 4n;
const ADMINISTRATOR = 1n << 3n;
const MEMBER_PERMS = (VIEW | SEND | EMBED | ATTACH | HISTORY).toString();
const STAFF_PERMS = (VIEW | SEND | EMBED | ATTACH | HISTORY | MANAGE_MESSAGES).toString();
const BOT_PERMS = (VIEW | SEND | EMBED | ATTACH | HISTORY | MANAGE_MESSAGES | MANAGE_CHANNELS).toString();

const { guildId } = config.discord;
const number = (id: number) => `#${String(id).padStart(4, '0')}`;
const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'membre';

interface TicketRow {
  id: number;
  discord_id: string;
  user_id: string | null;
  username: string | null;
  motif: TicketMotif;
  subject: string | null;
  channel_id: string | null;
  status: 'open' | 'closed';
  created_at: string;
}

/** Identifiants des rôles « Staff 6 » et « Arbitre 6 » sur le serveur. */
async function teamRoles(): Promise<{ staff?: string; referee?: string }> {
  const roles = (await discord(`/guilds/${guildId}/roles`)) as { id: string; name: string }[];
  const find = (name: string) => roles.find((role) => role.name.toLowerCase() === name.toLowerCase())?.id;
  return { staff: find('Staff 6'), referee: find('Arbitre 6') };
}

// --- Panneau ------------------------------------------------------------------------------------

function panelMessage() {
  return {
    embeds: [
      {
        title: '🎫 Besoin de l’équipe SixSence ?',
        description: [
          'Ouvre un ticket : un salon privé est créé entre toi et l’équipe.',
          '',
          ...Object.values(TICKET_MOTIFS).map((motif) => `${motif.emoji} **${motif.label}** · ${motif.hint}`),
          '',
          '*Un ticket ouvert à la fois. Reste correct : les tickets abusifs sont sanctionnés.*',
        ].join('\n'),
        color: GOLD,
      },
    ],
    components: [
      {
        type: 1,
        components: Object.entries(TICKET_MOTIFS).map(([key, motif]) => ({ type: 2, style: motif.style, label: motif.label, emoji: { name: motif.emoji }, custom_id: `ticket:open:${key}` })),
      },
    ],
  };
}

/** Publie le panneau des tickets, ou met à jour celui déjà publié (pas de doublon). */
export async function publishTicketPanel(): Promise<{ action: 'posted' | 'updated' }> {
  const channelId = config.discord.ticketsChannelId;
  if (!discordEnabled || !channelId) throw new HttpError(409, 'DISCORD_DISABLED', 'Le bot Discord ou le salon des tickets (DISCORD_TICKETS_CHANNEL_ID) n’est pas configuré.');
  const { data } = await supabase.from('app_state').select('value').eq('key', PANEL_KEY).maybeSingle();
  const [savedChannel, savedMessage] = ((data as { value?: string } | null)?.value ?? '').split(':');
  try {
    if (savedChannel === channelId && savedMessage) {
      try {
        await discord(`/channels/${channelId}/messages/${savedMessage}`, { method: 'PATCH', body: panelMessage() });
        return { action: 'updated' };
      } catch {
        // Message supprimé : on en publie un nouveau.
      }
    }
    const posted = (await discord(`/channels/${channelId}/messages`, { method: 'POST', body: panelMessage() })) as { id: string };
    await supabase.from('app_state').upsert({ key: PANEL_KEY, value: `${channelId}:${posted.id}` });
    return { action: 'posted' };
  } catch (caught) {
    throw new HttpError(502, 'DISCORD_ERROR', `Publication impossible : vérifie que le bot peut écrire dans le salon (${(caught as Error).message}).`);
  }
}

// --- Interactions (boutons et fenêtre) ----------------------------------------------------------

export interface TicketInteraction {
  type: number;
  token: string;
  application_id: string;
  channel_id?: string;
  data?: { custom_id?: string; components?: { components?: { custom_id: string; value: string }[] }[] };
  member?: { user?: { id: string; username?: string; global_name?: string | null }; roles?: string[]; permissions?: string };
}

/** Réponse immédiate à un bouton ou à une fenêtre de ticket ; null si l'interaction n'est pas un ticket. */
export function handleTicketInteraction(interaction: TicketInteraction): { type: number; data?: unknown } | null {
  const id = interaction.data?.custom_id ?? '';
  if (!id.startsWith('ticket:')) return null;
  const [, action, motif = ''] = id.split(':');

  // Bouton du panneau : fenêtre de description.
  if (interaction.type === 3 && action === 'open' && isMotif(motif)) {
    const spec = TICKET_MOTIFS[motif];
    const fields = [
      ...(motif === 'contestation'
        ? [{ type: 4, custom_id: 'match', label: 'Match concerné (lien ou numéro, facultatif)', style: 1, required: false, max_length: 200 }]
        : []),
      ...(motif === 'autre' ? [{ type: 4, custom_id: 'reason', label: 'Motif', style: 1, required: true, min_length: 3, max_length: 60, placeholder: 'Ex. : partenariat, recrutement staff…' }] : []),
      { type: 4, custom_id: 'subject', label: 'Explique ta demande', style: 2, required: true, min_length: 10, max_length: 1000, placeholder: spec.hint },
    ];
    return {
      type: 9,
      data: { custom_id: `ticket:modal:${motif}`, title: `${spec.emoji} Ticket · ${spec.label}`, components: fields.map((field) => ({ type: 1, components: [field] })) },
    };
  }

  // Fenêtre envoyée, bouton « Fermer » ou « Supprimer » : réponse différée visible du seul auteur.
  void (async () => {
    let content: string;
    try {
      if (interaction.type === 5 && action === 'modal' && isMotif(motif)) content = await openTicket(interaction, motif);
      else if (interaction.type === 3 && action === 'close') content = await closeTicket(interaction);
      else if (interaction.type === 3 && action === 'delete') content = await deleteTicketChannel(interaction);
      else content = 'Action inconnue.';
    } catch (caught) {
      console.warn('[tickets]', (caught as Error).message);
      content = 'Oups, impossible pour le moment. Réessaie dans un instant ou contacte un membre de l’équipe.';
    }
    await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    }).catch((caught) => console.warn('[tickets] réponse impossible', (caught as Error).message));
  })();
  return { type: 5, data: { flags: EPHEMERAL } };
}

const fieldValue = (interaction: TicketInteraction, key: string) =>
  interaction.data?.components?.flatMap((row) => row.components ?? []).find((field) => field.custom_id === key)?.value?.trim() ?? '';

async function openTicket(interaction: TicketInteraction, motif: TicketMotif): Promise<string> {
  const user = interaction.member?.user;
  if (!user || !guildId) return 'Les tickets s’ouvrent depuis le serveur SixSence.';
  const name = user.global_name || user.username || 'membre';
  const subject = fieldValue(interaction, 'subject').slice(0, 1000);
  const match = fieldValue(interaction, 'match').slice(0, 200);
  // « Autre » : motif écrit par le membre (titre du ticket).
  const reason = motif === 'autre' ? fieldValue(interaction, 'reason').replace(/\s+/g, ' ').slice(0, 60) : '';

  // Un ticket ouvert à la fois (salon disparu entre-temps : le ticket est considéré comme fermé).
  const { data: existing } = await supabase.from('discord_tickets').select('id, channel_id').eq('discord_id', user.id).eq('status', 'open').maybeSingle();
  if (existing) {
    const open = existing as { id: number; channel_id: string | null };
    const alive = open.channel_id ? await discord(`/channels/${open.channel_id}`).then(() => true).catch(() => false) : false;
    if (alive) return `Tu as déjà un ticket ouvert : <#${open.channel_id}>.`;
    await supabase.from('discord_tickets').update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: 'salon disparu' }).eq('id', open.id);
  }

  const { data: linked } = await supabase.from('users').select('id, username').eq('discord_id', user.id).maybeSingle();
  const site = linked as { id: string; username: string } | null;
  const { data: inserted, error } = await supabase
    .from('discord_tickets')
    .insert({ discord_id: user.id, user_id: site?.id ?? null, username: name, motif, subject: [reason ? `Motif : ${reason}` : '', subject, match ? `Match : ${match}` : ''].filter(Boolean).join('\n\n') })
    .select('*')
    .single();
  if (error || !inserted) return error?.code === '23505' ? 'Tu as déjà un ticket ouvert.' : 'Impossible d’ouvrir le ticket pour le moment.';
  const ticket = inserted as TicketRow;
  const spec = TICKET_MOTIFS[motif];
  const label = reason || spec.label;

  try {
    const roles = await teamRoles();
    const overwrites = [
      { id: guildId, type: 0, allow: '0', deny: VIEW.toString() },
      { id: user.id, type: 1, allow: MEMBER_PERMS, deny: '0' },
      { id: interaction.application_id, type: 1, allow: BOT_PERMS, deny: '0' },
      ...(roles.staff ? [{ id: roles.staff, type: 0, allow: STAFF_PERMS, deny: '0' }] : []),
      ...(roles.referee && motif === 'contestation' ? [{ id: roles.referee, type: 0, allow: STAFF_PERMS, deny: '0' }] : []),
    ];
    const channel = (await discord(`/guilds/${guildId}/channels`, {
      method: 'POST',
      body: {
        name: `ticket-${String(ticket.id).padStart(4, '0')}-${slug(name)}`,
        type: 0,
        parent_id: config.discord.ticketsCategoryId || undefined,
        topic: `${spec.emoji} ${label} · ticket ${number(ticket.id)} de ${name}`,
        permission_overwrites: overwrites,
      },
    })) as { id: string };
    await supabase.from('discord_tickets').update({ channel_id: channel.id }).eq('id', ticket.id);

    const pings = [roles.staff, motif === 'contestation' ? roles.referee : undefined].filter(Boolean) as string[];
    await discord(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: {
        content: [`<@${user.id}>`, ...pings.map((role) => `<@&${role}>`)].join(' '),
        allowed_mentions: { users: [user.id], roles: pings },
        embeds: [
          {
            title: `${spec.emoji} Ticket ${number(ticket.id)} · ${label}`,
            description: subject,
            color: spec.color,
            fields: [
              ...(match ? [{ name: 'Match concerné', value: match }] : []),
              { name: 'Compte SixSence', value: site ? `[${site.username}](${config.siteUrl}/cod/profile/${site.id})` : 'Pas encore lié au site' },
            ],
            footer: { text: 'L’équipe te répond ici. Clique sur « Fermer » quand c’est réglé.' },
            timestamp: new Date().toISOString(),
          },
        ],
        components: [{ type: 1, components: [{ type: 2, style: 2, label: 'Fermer le ticket', emoji: { name: '🔒' }, custom_id: 'ticket:close' }] }],
      },
    });
    logToDiscord(`🎫 **Ticket ${number(ticket.id)}** (${label}) ouvert par **${name}** : <#${channel.id}>`);
    return `✅ Ton ticket ${number(ticket.id)} est ouvert : <#${channel.id}>. L’équipe te répond là-bas.`;
  } catch (caught) {
    await supabase.from('discord_tickets').update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: 'échec de création' }).eq('id', ticket.id);
    throw caught;
  }
}

/** Le membre fait partie de l'équipe (Staff 6, Arbitre 6, ou droits de gérer les salons / administrateur). */
async function isTeam(interaction: TicketInteraction): Promise<boolean> {
  const perms = BigInt(interaction.member?.permissions ?? '0');
  if ((perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_CHANNELS) !== 0n) return true;
  const roles = await teamRoles();
  const mine = interaction.member?.roles ?? [];
  return [roles.staff, roles.referee].some((role) => role && mine.includes(role));
}

async function ticketOfChannel(channelId: string | undefined): Promise<TicketRow | null> {
  if (!channelId) return null;
  const { data } = await supabase.from('discord_tickets').select('*').eq('channel_id', channelId).order('id', { ascending: false }).limit(1).maybeSingle();
  return (data as TicketRow | null) ?? null;
}

/** Transcription texte du salon (500 derniers messages au plus), du plus ancien au plus récent. */
async function transcript(channelId: string): Promise<string> {
  const messages: { author: { username: string; global_name?: string | null; bot?: boolean }; content: string; timestamp: string; attachments?: { url: string }[]; embeds?: { title?: string; description?: string }[] }[] = [];
  let before = '';
  for (let page = 0; page < 5; page++) {
    const batch = (await discord(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`)) as (typeof messages[number] & { id: string })[];
    messages.push(...batch);
    if (batch.length < 100) break;
    before = batch[batch.length - 1]!.id;
  }
  return messages
    .reverse()
    .map((message) => {
      const when = new Date(message.timestamp).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
      const body = [message.content, ...(message.embeds ?? []).map((embed) => [embed.title, embed.description].filter(Boolean).join(' : ')), ...(message.attachments ?? []).map((file) => `[fichier] ${file.url}`)]
        .filter(Boolean)
        .join('\n');
      return `[${when}] ${message.author.global_name || message.author.username}${message.author.bot ? ' (bot)' : ''} : ${body}`;
    })
    .join('\n');
}

/** Envoie la transcription en fichier dans le salon du journal (multipart : pas possible avec discord()). */
async function postTranscript(ticket: TicketRow, closer: string, text: string): Promise<void> {
  const channel = config.discord.logsChannelId || config.discord.staffChannelId;
  if (!channel) return;
  const spec = TICKET_MOTIFS[ticket.motif];
  const form = new FormData();
  form.append(
    'payload_json',
    JSON.stringify({
      content: `🔒 **Ticket ${number(ticket.id)}** (${spec.label}) de **${ticket.username ?? 'membre'}** fermé par **${closer}**.`,
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: `ticket-${String(ticket.id).padStart(4, '0')}.txt` }],
    }),
  );
  form.append('files[0]', new Blob([`Ticket ${number(ticket.id)} · ${spec.label} · ${ticket.username ?? ''}\n\n${text}\n`], { type: 'text/plain' }), `ticket-${String(ticket.id).padStart(4, '0')}.txt`);
  const res = await fetch(`${API}/channels/${channel}/messages`, { method: 'POST', headers: { Authorization: `Bot ${config.discord.botToken}` }, body: form });
  if (!res.ok) throw new Error(`transcription : ${res.status}`);
}

async function closeTicket(interaction: TicketInteraction): Promise<string> {
  const ticket = await ticketOfChannel(interaction.channel_id);
  if (!ticket) return 'Ce salon n’est pas un ticket.';
  if (ticket.status === 'closed') return 'Ce ticket est déjà fermé.';
  const closerId = interaction.member?.user?.id ?? '';
  const team = await isTeam(interaction);
  if (closerId !== ticket.discord_id && !team) return 'Seuls l’auteur du ticket et l’équipe peuvent le fermer.';
  const closer = interaction.member?.user?.global_name || interaction.member?.user?.username || 'membre';
  const channelId = ticket.channel_id!;

  // On marque d'abord (un double clic ne ferme pas deux fois), puis transcription, puis verrouillage.
  const { data: claimed } = await supabase
    .from('discord_tickets')
    .update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: closer })
    .eq('id', ticket.id)
    .eq('status', 'open')
    .select('id');
  if (!claimed?.length) return 'Ce ticket est déjà fermé.';
  try {
    await postTranscript(ticket, closer, await transcript(channelId));
  } catch (caught) {
    console.warn('[tickets] transcription impossible', (caught as Error).message);
  }
  await discord(`/channels/${channelId}/permissions/${ticket.discord_id}`, { method: 'PUT', body: { type: 1, allow: (VIEW | HISTORY).toString(), deny: SEND.toString() } }).catch(() => undefined);
  await discord(`/channels/${channelId}`, { method: 'PATCH', body: { name: `ferme-${String(ticket.id).padStart(4, '0')}-${slug(ticket.username ?? 'membre')}` } }).catch(() => undefined);
  await discord(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: {
      embeds: [{ description: `🔒 Ticket fermé par **${closer}**. La transcription est gardée par l’équipe.`, color: 0x6b7280 }],
      components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Supprimer le salon (équipe)', emoji: { name: '🗑️' }, custom_id: 'ticket:delete' }] }],
    },
  });
  logToDiscord(`🔒 Ticket ${number(ticket.id)} fermé par **${closer}**.`);
  return `Ticket ${number(ticket.id)} fermé.`;
}

async function deleteTicketChannel(interaction: TicketInteraction): Promise<string> {
  const ticket = await ticketOfChannel(interaction.channel_id);
  if (!ticket) return 'Ce salon n’est pas un ticket.';
  if (ticket.status !== 'closed') return 'Ferme d’abord le ticket (la transcription est enregistrée à la fermeture).';
  if (!(await isTeam(interaction))) return 'Seule l’équipe peut supprimer le salon d’un ticket.';
  await discord(`/channels/${ticket.channel_id}`, { method: 'DELETE' });
  return 'Salon supprimé.';
}
