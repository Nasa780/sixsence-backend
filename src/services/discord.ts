import { config } from '../config.js';
import { bus, type CodMatch } from '../events.js';
import { supabase } from '../supabase.js';
import { sendMatchFound, updateClosed, updateStarted } from './matchFoundDm.js';

/**
 * Intégration Discord, par l'API REST (pas besoin de connexion permanente du bot) :
 *   - message privé « Match trouvé » à chaque joueur, avec le lien du salon de match ;
 *   - deux salons vocaux (Équipe 1 / Équipe 2) créés au démarrage du match, supprimés à la fin ;
 *   - résultat publié dans un salon du serveur.
 *
 * Tout est facultatif et « au mieux » : une erreur Discord (DM fermés, droits
 * manquants) est journalisée mais n'empêche jamais le match de se dérouler.
 * Désactivé tant que DISCORD_BOT_TOKEN et DISCORD_GUILD_ID sont vides.
 */

const API = 'https://discord.com/api/v10';
/** Pas d'aperçu de lien sous les messages du bot (les liens restent cliquables). */
export const SUPPRESS_EMBEDS = 1 << 2;
const { botToken, guildId, matchCategoryId, resultsChannelId, staffChannelId } = config.discord;

export const discordEnabled = Boolean(botToken && guildId);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Appel à l'API Discord. Limite de débit (429, fréquente quand des salons sont créés et
 * supprimés à la suite) : on attend le délai demandé par Discord (15 s au plus) et on réessaie,
 * jusqu'à 3 fois.
 */
export async function discord(path: string, init: { method?: string; body?: unknown } = {}, attempt = 0): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(withoutStrayMentions(path, init.body)),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number((data as { retry_after?: number } | null)?.retry_after ?? res.headers.get('retry-after') ?? 1);
    await wait(Math.min(15, Math.max(0.5, retryAfter)) * 1000);
    return discord(path, init, attempt + 1);
  }
  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? res.statusText;
    throw new Error(`Discord ${init.method ?? 'GET'} ${path} : ${res.status} ${message}`);
  }
  return data;
}

/**
 * Règle des mentions : un message du bot ne notifie personne sauf s'il le demande explicitement
 * (allowed_mentions). Seules les annonces illustrées (rôles 🔔 choisis par les membres, services/announcements.ts)
 * et l'ouverture d'un ticket (membre et équipe) mentionnent quelqu'un ; tout autre message, même s'il contient
 * « @everyone » ou un pseudo, ne fait sonner aucun téléphone.
 */
function withoutStrayMentions(path: string, body: unknown): unknown {
  if (!/^\/channels\/\d+\/messages(\/\d+)?$/.test(path) || !body || typeof body !== 'object' || 'allowed_mentions' in body) return body;
  return { ...(body as Record<string, unknown>), allowed_mentions: { parse: [] } };
}

/** Droits d'un joueur dans le vocal de son match : voir, se connecter, parler, vidéo, détection de la voix. */
const VOICE_MEMBER = ((1n << 10n) | (1n << 20n) | (1n << 21n) | (1n << 9n) | (1n << 25n)).toString();

/**
 * Droits d'un salon vocal de match : ceux de la catégorie (repris tels quels), plus un accès nominatif pour
 * chaque joueur du match. Un joueur entre donc dans son vocal même sans rôle (« Player COD » n'arrive qu'après
 * son premier match classé, un nouveau venu n'a encore aucun rôle).
 */
export async function matchVoiceOverwrites(userIds: string[]): Promise<{ id: string; type: number; allow: string; deny: string }[]> {
  const players = [...(await discordIds(userIds)).values()];
  let inherited: { id: string; type: number; allow: string; deny: string }[] = [];
  if (matchCategoryId) {
    const category = (await discord(`/channels/${matchCategoryId}`).catch(() => null)) as { permission_overwrites?: typeof inherited } | null;
    inherited = category?.permission_overwrites ?? [];
  }
  return [...inherited.filter((overwrite) => !players.includes(overwrite.id)), ...players.map((id) => ({ id, type: 1, allow: VOICE_MEMBER, deny: '0' }))];
}

/** Identifiants Discord des joueurs (colonne users.discord_id, remplie à la connexion). */
export async function discordIds(userIds: string[]): Promise<Map<string, string>> {
  const { data } = await supabase.from('users').select('id, discord_id, username').in('id', userIds);
  return new Map(((data ?? []) as { id: string; discord_id: string | null }[]).filter((row) => row.discord_id).map((row) => [row.id, row.discord_id as string]));
}

async function usernames(userIds: string[]): Promise<Map<string, string>> {
  const { data } = await supabase.from('users').select('id, username').in('id', userIds);
  return new Map(((data ?? []) as { id: string; username: string }[]).map((row) => [row.id, row.username]));
}

/** Envoie un message privé à chaque joueur ; ignore ceux qui refusent les DM. */
export async function dm(userIds: string[], content: string): Promise<void> {
  const ids = await discordIds(userIds);
  for (const discordId of ids.values()) {
    try {
      const channel = (await discord('/users/@me/channels', { method: 'POST', body: { recipient_id: discordId } })) as { id: string };
      await discord(`/channels/${channel.id}/messages`, { method: 'POST', body: { content, flags: SUPPRESS_EMBEDS } });
    } catch (error) {
      console.warn('[discord] message privé impossible', (error as Error).message);
    }
  }
}

const matchUrl = (match: CodMatch) => `${config.siteUrl}/cod/match/${match.id}`;

/** Message dans le salon privé de l'équipe (arbitrages, signalements). Sans salon configuré : rien. */
export async function notifyStaff(content: string): Promise<void> {
  if (!discordEnabled || !staffChannelId) return;
  try {
    await discord(`/channels/${staffChannelId}/messages`, {
      method: 'POST',
      body: { content: content.slice(0, 1900), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS },
    });
  } catch (error) {
    console.warn('[discord] message à l’équipe impossible', (error as Error).message);
  }
}

/** Match trouvé : message privé premium mis à jour en direct (services/matchFoundDm.ts). */
export async function onMatchFound(match: CodMatch): Promise<void> {
  if (!discordEnabled) return;
  await sendMatchFound(match);
}

/** Match démarré : crée les deux salons vocaux et envoie le lien à chaque équipe. */
export async function onMatchStart(match: CodMatch): Promise<void> {
  if (!discordEnabled) return;

  // Réservation atomique : si deux joueurs acceptent à la même seconde, un seul appel crée les salons.
  const { data: claimed } = await supabase
    .from('cod_matches')
    .update({ discord_channels: { pending: 'true' } })
    .eq('id', match.id)
    .eq('discord_channels', '{}')
    .select('id');
  if (!claimed || claimed.length === 0) return;

  const shortId = match.id.slice(0, 4).toUpperCase();
  const create = async (team: string, players: string[]) =>
    discord(`/guilds/${guildId}/channels`, {
      method: 'POST',
      body: {
        name: `${match.map} ${shortId} · ${team}`,
        type: 2, // salon vocal
        user_limit: match.team_size + 1,
        ...(matchCategoryId ? { parent_id: matchCategoryId } : {}),
        permission_overwrites: await matchVoiceOverwrites(players),
      },
    }) as Promise<{ id: string }>;

  // L'un après l'autre (moins de risque de limite de débit) ; en cas d'échec, aucun salon orphelin.
  const created: string[] = [];
  try {
    const teamA = await create('Équipe 1', match.team_a);
    created.push(teamA.id);
    const teamB = await create('Équipe 2', match.team_b);
    created.push(teamB.id);
    await supabase.from('cod_matches').update({ discord_channels: { teamA: teamA.id, teamB: teamB.id } }).eq('id', match.id);
    const link = (channelId: string) => `https://discord.com/channels/${guildId}/${channelId}`;
    // Le message « Match trouvé » passe à « C'est parti » avec le bouton du vocal ; message privé classique à défaut.
    const missed = new Set(await updateStarted(match, { teamA: teamA.id, teamB: teamB.id }));
    await dm(match.team_a.filter((id) => missed.has(id)), `**Le match démarre** — rejoins le vocal de l'Équipe 1 : ${link(teamA.id)}\nSalon de match : ${matchUrl(match)}`);
    await dm(match.team_b.filter((id) => missed.has(id)), `**Le match démarre** — rejoins le vocal de l'Équipe 2 : ${link(teamB.id)}\nSalon de match : ${matchUrl(match)}`);
  } catch (error) {
    console.warn('[discord] création des salons vocaux impossible', (error as Error).message);
    for (const channelId of created) await discord(`/channels/${channelId}`, { method: 'DELETE' }).catch(() => {});
    await updateStarted(match, { teamA: null, teamB: null }).catch(() => []);
    await supabase.from('cod_matches').update({ discord_channels: {} }).eq('id', match.id);
  }
}

/**
 * Tâche périodique : pour chaque match terminé ou annulé pas encore traité,
 * supprime ses salons vocaux et publie le résultat (matchs récents uniquement).
 */
let sweeping = false;
let sweepAgain = false;

export async function sweepDiscord(): Promise<void> {
  if (!discordEnabled) return;
  // Une seule passe à la fois (fin de match + tâche périodique) : sinon un résultat serait publié deux fois.
  if (sweeping) {
    sweepAgain = true;
    return;
  }
  sweeping = true;
  try {
    do {
      sweepAgain = false;
      await sweepOnce();
    } while (sweepAgain);
  } finally {
    sweeping = false;
  }
}

async function sweepOnce(): Promise<void> {
  const { data, error } = await supabase
    .from('cod_matches')
    .select('*')
    .in('status', ['completed', 'cancelled'])
    .eq('discord_done', false)
    .order('completed_at', { ascending: true })
    .limit(20);
  if (error || !data) {
    if (error) console.warn('[discord] lecture des matchs terminés impossible', error.message);
    return;
  }

  for (const match of data as CodMatch[]) {
    for (const [key, channelId] of Object.entries(match.discord_channels ?? {})) {
      if (key === 'pending') continue;
      try {
        await discord(`/channels/${channelId}`, { method: 'DELETE' });
        console.log(`[discord] salon ${channelId} du match ${match.id} supprimé`);
      } catch (deleteError) {
        console.warn('[discord] suppression du salon impossible', (deleteError as Error).message);
      }
    }

    const recent = match.completed_at && Date.now() - new Date(match.completed_at).getTime() < 60 * 60 * 1000;
    // Message privé « Match trouvé » : état final (terminé ou annulé), sans le bouton du vocal supprimé.
    if (recent) await updateClosed(match).catch((caught) => console.warn('[discord] message de fin impossible', (caught as Error).message));
    // Match corrigé : l'ancien message de résultat est supprimé (remplacé ci-dessous si le match a un vainqueur).
    let resultMessage = match.discord_result_message ?? null;
    if (resultMessage && match.corrected_at && resultsChannelId) {
      try {
        await discord(`/channels/${resultsChannelId}/messages/${resultMessage}`, { method: 'DELETE' });
      } catch (deleteError) {
        console.warn('[discord] suppression de l’ancien résultat impossible', (deleteError as Error).message);
      }
      resultMessage = null;
    }
    if (match.status === 'completed' && match.winner && resultsChannelId && recent) {
      try {
        const names = await usernames([...match.team_a, ...match.team_b]);
        const team = (ids: string[]) =>
          ids.map((id) => `${names.get(id) ?? 'Joueur'} (${(match.points_changes?.[id] ?? 0) >= 0 ? '+' : ''}${match.points_changes?.[id] ?? 0})`).join(', ');
        const winners = match.winner === 'A' ? match.team_a : match.team_b;
        const losers = match.winner === 'A' ? match.team_b : match.team_a;
        const posted = (await discord(`/channels/${resultsChannelId}/messages`, {
          method: 'POST',
          body: {
            allowed_mentions: { parse: [] },
            embeds: [
              {
                author: { name: `🎯 CLASSÉ · ${match.team_size}v${match.team_size}` },
                title: `${match.map} · ${match.mode}`,
                url: matchUrl(match),
                color: 0xd4af37,
                description: `🏆 Victoire de l'Équipe ${match.winner === 'A' ? '1' : '2'}${match.corrected_at ? '\n_Résultat corrigé par l’équipe SixSence_' : ''}`,
                fields: [
                  { name: 'Gagnants', value: team(winners).slice(0, 1000) || '—' },
                  { name: 'Perdants', value: team(losers).slice(0, 1000) || '—' },
                ],
                footer: { text: 'Classé solo' },
                timestamp: match.completed_at ?? undefined,
              },
            ],
          },
        })) as { id?: string } | null;
        resultMessage = posted?.id ?? null;
      } catch (postError) {
        console.warn('[discord] publication du résultat impossible', (postError as Error).message);
      }
    }

    await supabase.from('cod_matches').update({ discord_done: true, discord_result_message: resultMessage }).eq('id', match.id);
    if (match.status === 'completed') bus.emit('match:finalized', match);
    if (match.status === 'cancelled' && match.cancel_reason === 'abandoned' && recent) bus.emit('match:abandoned', match);
  }
}
