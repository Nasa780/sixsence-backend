import { config } from '../config.js';
import type { CodMatch } from '../events.js';
import { supabase } from '../supabase.js';

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
const { botToken, guildId, matchCategoryId, resultsChannelId, staffChannelId } = config.discord;

export const discordEnabled = Boolean(botToken && guildId);

async function discord(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? res.statusText;
    throw new Error(`Discord ${init.method ?? 'GET'} ${path} : ${res.status} ${message}`);
  }
  return data;
}

/** Identifiants Discord des joueurs (colonne users.discord_id, remplie à la connexion). */
async function discordIds(userIds: string[]): Promise<Map<string, string>> {
  const { data } = await supabase.from('users').select('id, discord_id, username').in('id', userIds);
  return new Map(((data ?? []) as { id: string; discord_id: string | null }[]).filter((row) => row.discord_id).map((row) => [row.id, row.discord_id as string]));
}

async function usernames(userIds: string[]): Promise<Map<string, string>> {
  const { data } = await supabase.from('users').select('id, username').in('id', userIds);
  return new Map(((data ?? []) as { id: string; username: string }[]).map((row) => [row.id, row.username]));
}

/** Envoie un message privé à chaque joueur ; ignore ceux qui refusent les DM. */
async function dm(userIds: string[], content: string): Promise<void> {
  const ids = await discordIds(userIds);
  for (const discordId of ids.values()) {
    try {
      const channel = (await discord('/users/@me/channels', { method: 'POST', body: { recipient_id: discordId } })) as { id: string };
      await discord(`/channels/${channel.id}/messages`, { method: 'POST', body: { content } });
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
      body: { content: content.slice(0, 1900), allowed_mentions: { parse: [] } },
    });
  } catch (error) {
    console.warn('[discord] message à l’équipe impossible', (error as Error).message);
  }
}

/** Match trouvé : prévenir chaque joueur qu'il a une minute pour accepter. */
export async function onMatchFound(match: CodMatch): Promise<void> {
  if (!discordEnabled) return;
  await dm(
    [...match.team_a, ...match.team_b],
    `**Match trouvé sur SixSence** — ${match.map} · ${match.mode} (${match.team_size}v${match.team_size})\n` +
      `Tu as ${config.cod.readySeconds} secondes pour accepter : ${matchUrl(match)}`,
  );
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
  const create = (team: string) =>
    discord(`/guilds/${guildId}/channels`, {
      method: 'POST',
      body: {
        name: `${match.map} ${shortId} · ${team}`,
        type: 2, // salon vocal
        user_limit: match.team_size + 1,
        ...(matchCategoryId ? { parent_id: matchCategoryId } : {}),
      },
    }) as Promise<{ id: string }>;

  try {
    const [teamA, teamB] = await Promise.all([create('Équipe 1'), create('Équipe 2')]);
    await supabase.from('cod_matches').update({ discord_channels: { teamA: teamA.id, teamB: teamB.id } }).eq('id', match.id);
    const link = (channelId: string) => `https://discord.com/channels/${guildId}/${channelId}`;
    await dm(match.team_a, `**Le match démarre** — rejoins le vocal de l'Équipe 1 : ${link(teamA.id)}\nSalon de match : ${matchUrl(match)}`);
    await dm(match.team_b, `**Le match démarre** — rejoins le vocal de l'Équipe 2 : ${link(teamB.id)}\nSalon de match : ${matchUrl(match)}`);
  } catch (error) {
    console.warn('[discord] création des salons vocaux impossible', (error as Error).message);
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
    if (match.status === 'completed' && match.winner && resultsChannelId && recent) {
      try {
        const names = await usernames([...match.team_a, ...match.team_b]);
        const team = (ids: string[]) =>
          ids.map((id) => `${names.get(id) ?? 'Joueur'} (${(match.points_changes?.[id] ?? 0) >= 0 ? '+' : ''}${match.points_changes?.[id] ?? 0})`).join(', ');
        const winners = match.winner === 'A' ? match.team_a : match.team_b;
        const losers = match.winner === 'A' ? match.team_b : match.team_a;
        await discord(`/channels/${resultsChannelId}/messages`, {
          method: 'POST',
          body: {
            content:
              `**${match.map}** · ${match.mode} — victoire de l'Équipe ${match.winner === 'A' ? '1' : '2'}\n` +
              `Gagnants : ${team(winners)}\nPerdants : ${team(losers)}\n${matchUrl(match)}`,
          },
        });
      } catch (postError) {
        console.warn('[discord] publication du résultat impossible', (postError as Error).message);
      }
    }

    await supabase.from('cod_matches').update({ discord_done: true }).eq('id', match.id);
  }
}
