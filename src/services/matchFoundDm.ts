import { config } from '../config.js';
import type { CodMatch, ReadyCheckFailure } from '../events.js';
import { supabase } from '../supabase.js';
import { discord, discordIds } from './discord.js';

/**
 * Message privé Discord « Match trouvé » : un seul message par joueur et par match, mis à jour à chaque étape
 * (identifiants gardés dans cod_matches.discord_dm, migration 0045). Infos de base seulement : mode, format, map,
 * heure exacte de fin du délai (<t:…:T>, le compte à rebours relatif de Discord se met mal à jour) ; jamais les joueurs, les équipes ni les points. Images : /api/og/match du site.
 *
 *   ① match trouvé    vert, bannière, « Je suis prêt » + « Ouvrir le match »
 *   ② prêt            vert, barre des joueurs prêts, bouton grisé
 *   ③ c'est parti     doré, barre pleine, « Rejoindre le vocal » + « Ouvrir le match »
 *   ④ annulé          gris, selon le cas : remis en tête de file, groupe libéré, ou pas accepté à temps
 */

const GREEN = 0x34d399;
const GOLD = 0xe7c05a;
const GREY = 0x6b7280;
const site = config.siteUrl;

type Row = { type: number; components: unknown[] };
type Body = { content: string; embeds: unknown[]; components: Row[]; flags?: number };

const matchLink = (matchId: string) => `${site}/cod/match/${matchId}`;
const linkButton = (label: string, url: string, emoji?: string) => ({ type: 2, style: 5, label, url, ...(emoji ? { emoji: { name: emoji } } : {}) });
const openButton = (matchId: string) => linkButton('Ouvrir le match', matchLink(matchId));
const deadlineOf = (match: CodMatch) => Math.floor(new Date(match.ready_deadline ?? Date.now() + config.cod.readySeconds * 1000).getTime() / 1000);
const total = (match: CodMatch) => match.team_a.length + match.team_b.length;
const bar = (ready: number, of: number, go = false) => `${site}/api/og/match?bar=${ready}&total=${of}${go ? '&go=1' : ''}`;

function foundBody(match: CodMatch): Body {
  const banner = new URLSearchParams({ map: match.map, format: match.format ?? `${match.team_size}v${match.team_size}`, mode: match.mode });
  return {
    content: '',
    embeds: [
      {
        color: GREEN,
        title: '⚡ MATCH TROUVÉ',
        description: `**Classé ${match.format ?? `${match.team_size}v${match.team_size}`}** · ${match.mode}\n⏳ Accepte avant **<t:${deadlineOf(match)}:T>**`,
        image: { url: `${site}/api/og/match?${banner.toString()}` },
      },
    ],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Je suis prêt', emoji: { name: '✅' }, custom_id: `ready:${match.id}` }, openButton(match.id)] }],
  };
}

function readyBody(match: CodMatch): Body {
  const ready = (match.ready_users ?? []).length;
  return {
    content: '',
    embeds: [{ color: GREEN, title: '✅ TU ES PRÊT', description: `En attente des autres joueurs · fin à **<t:${deadlineOf(match)}:T>**`, image: { url: bar(ready, total(match)) } }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Prêt', emoji: { name: '✔️' }, custom_id: `ready:${match.id}`, disabled: true }, openButton(match.id)] }],
  };
}

function startedBody(match: CodMatch, voiceId: string | null): Body {
  const voice = voiceId ? [linkButton('Rejoindre le vocal', `https://discord.com/channels/${config.discord.guildId}/${voiceId}`, '🔊')] : [];
  return {
    content: '',
    embeds: [
      {
        color: GOLD,
        title: '🎮 C’EST PARTI',
        description: voiceId ? 'Rejoins le vocal de ton équipe, puis suis la feuille de match.' : 'Suis la feuille de match pour lancer la partie.',
        image: { url: bar(total(match), total(match), true) },
      },
    ],
    components: [{ type: 1, components: [...voice, openButton(match.id)] }],
  };
}

function abortedBody(kind: 'requeued' | 'released' | 'missing'): Body {
  const text = {
    requeued: 'Un joueur n’a pas accepté à temps. Tu es remis automatiquement en tête de file.',
    released: 'Un joueur n’a pas accepté à temps. Ton groupe reste formé : relance la recherche quand vous êtes prêts.',
    missing: 'Tu n’as pas accepté à temps : tu es retiré de la file et un avertissement est enregistré.',
  }[kind];
  return {
    content: '',
    embeds: [{ color: GREY, title: '⌛ MATCH ANNULÉ', description: text }],
    components: [{ type: 1, components: [linkButton(kind === 'requeued' ? 'Voir la file' : 'Relancer une recherche', `${site}/cod/ranked`)] }],
  };
}

// --- Envoi et mises à jour -------------------------------------------------------------------

async function storedMessages(matchId: string): Promise<Record<string, string>> {
  const { data } = await supabase.from('cod_matches').select('discord_dm').eq('id', matchId).maybeSingle();
  return ((data as { discord_dm?: Record<string, string> } | null)?.discord_dm ?? {}) as Record<string, string>;
}

async function edit(ref: string | undefined, body: Body): Promise<boolean> {
  if (!ref) return false;
  const [channelId, messageId] = ref.split(':');
  try {
    await discord(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body });
    return true;
  } catch (caught) {
    console.warn('[discord] mise à jour du message « match trouvé » impossible', (caught as Error).message);
    return false;
  }
}

/** ① Match trouvé : un message privé par joueur, identifiants gardés pour les mises à jour. */
export async function sendMatchFound(match: CodMatch): Promise<void> {
  const ids = await discordIds([...match.team_a, ...match.team_b]);
  const sent: Record<string, string> = {};
  for (const [userId, discordId] of ids) {
    try {
      const channel = (await discord('/users/@me/channels', { method: 'POST', body: { recipient_id: discordId } })) as { id: string };
      const message = (await discord(`/channels/${channel.id}/messages`, { method: 'POST', body: foundBody(match) })) as { id: string };
      sent[userId] = `${channel.id}:${message.id}`;
    } catch (caught) {
      console.warn('[discord] message « match trouvé » impossible', (caught as Error).message);
    }
  }
  if (Object.keys(sent).length) await supabase.from('cod_matches').update({ discord_dm: sent }).eq('id', match.id);
}

/** ② Un joueur a accepté : les messages des joueurs prêts affichent la barre à jour (les autres gardent ①). */
export async function updateReady(match: CodMatch): Promise<void> {
  if (match.status !== 'ready_check') return;
  const refs = await storedMessages(match.id);
  await Promise.all((match.ready_users ?? []).map((userId) => edit(refs[userId], readyBody(match))));
}

/**
 * ③ Tout le monde est prêt : bouton du vocal de son équipe. Renvoie les joueurs dont le message n'a pas pu
 * être mis à jour (à prévenir autrement).
 */
export async function updateStarted(match: CodMatch, voice: { teamA: string | null; teamB: string | null }): Promise<string[]> {
  const refs = await storedMessages(match.id);
  const missed: string[] = [];
  for (const [ids, voiceId] of [
    [match.team_a, voice.teamA],
    [match.team_b, voice.teamB],
  ] as const) {
    for (const userId of ids) if (!(await edit(refs[userId], startedBody(match, voiceId)))) missed.push(userId);
  }
  return missed;
}

/** ④ Vérification échouée : chacun voit ce qui lui arrive (remis en file, groupe libéré, ou absent). */
export async function updateAborted(failure: ReadyCheckFailure): Promise<void> {
  const refs = await storedMessages(failure.match_id);
  await Promise.all([
    ...failure.accepted.map((userId) => edit(refs[userId], abortedBody('requeued'))),
    ...(failure.released ?? []).map((userId) => edit(refs[userId], abortedBody('released'))),
    ...failure.missing.map((userId) => edit(refs[userId], abortedBody('missing'))),
  ]);
}
