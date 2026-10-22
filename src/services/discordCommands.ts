import { createPublicKey, verify } from 'node:crypto';
import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { RANK_ROLES } from './community.js';
import { discord, discordEnabled } from './discord.js';
import { getQueueSummaries } from './queue.js';
import { teamStatus } from './teamMatches.js';
import { handleTicketInteraction, type TicketInteraction } from './tickets.js';

/**
 * Commandes Discord du bot (« /profil », « /classement », « /equipe », « /trophees », « /file », « /match »,
 * « /site ») : Discord appelle POST /discord/interactions (adresse à déclarer dans le portail développeur,
 * champ « Interactions Endpoint URL ») ; chaque requête est signée (ed25519, DISCORD_PUBLIC_KEY).
 * Lecture seule : rien ne se modifie depuis Discord (sauf les tickets, boutons et fenêtres traités par services/tickets.ts). Réponse différée (Discord exige une réponse en 3 s),
 * puis message complété. Commandes enregistrées sur le serveur DISCORD_GUILD_ID au démarrage.
 */

const { publicKey, guildId } = config.discord;
export const commandsEnabled = discordEnabled && /^[0-9a-f]{64}$/i.test(publicKey);

const SITE = config.siteUrl;
const GOLD = 0xd4af37;
const CYAN = 0x22d3ee;
const EPHEMERAL = 1 << 6;
const ACTIVE_COD = ['ready_check', 'in_progress', 'awaiting_confirmation', 'disputed'];
const ACTIVE_TEAM = ['in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed'];
const fr = (n: number) => n.toLocaleString('fr-FR');
const rankOf = (points: number) => RANK_ROLES.find((rank) => points >= rank.min) ?? RANK_ROLES[RANK_ROLES.length - 1]!;

// --- Définition des commandes -------------------------------------------------------------------

const COMMANDS = [
  {
    name: 'profil',
    description: 'Rang, points et bilan d’un joueur SixSence',
    options: [{ type: 3, name: 'joueur', description: 'Pseudo (sans pseudo : ton profil)', required: false }],
  },
  {
    name: 'classement',
    description: 'Top 10 du classé ou de la Division',
    options: [
      {
        type: 3,
        name: 'mode',
        description: 'Classé (joueurs) ou Division (équipes)',
        required: false,
        choices: [
          { name: 'Classé', value: 'classe' },
          { name: 'Division', value: 'division' },
        ],
      },
    ],
  },
  {
    name: 'equipe',
    description: 'Fiche rapide d’une équipe de la Division',
    options: [{ type: 3, name: 'tag', description: 'Tag de l’équipe (ex. SIX)', required: true }],
  },
  { name: 'trophees', description: 'Prochains trophées Horus et Anubis' },
  { name: 'file', description: 'Joueurs et équipes en recherche, matchs en cours' },
  { name: 'match', description: 'Ton match en cours (visible de toi seul)' },
  { name: 'site', description: 'Liens utiles de SixSence' },
];

/** Enregistre les commandes sur le serveur (instantané, contrairement aux commandes globales). */
export async function registerCommands(): Promise<void> {
  if (!commandsEnabled) return;
  try {
    const app = (await discord('/oauth2/applications/@me')) as { id: string };
    await discord(`/applications/${app.id}/guilds/${guildId}/commands`, { method: 'PUT', body: COMMANDS });
    console.log(`[discord] ${COMMANDS.length} commandes enregistrées`);
  } catch (caught) {
    console.warn('[discord] commandes non enregistrées', (caught as Error).message);
  }
}

// --- Signature --------------------------------------------------------------------------------

const keyObject = commandsEnabled
  ? createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' })
  : null;

/** Signature ed25519 de Discord (en-têtes X-Signature-Ed25519 et X-Signature-Timestamp). */
export function validSignature(raw: Buffer, signature: string | undefined, timestamp: string | undefined): boolean {
  if (!keyObject || !signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  try {
    return verify(null, Buffer.concat([Buffer.from(timestamp), raw]), keyObject, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// --- Interactions -------------------------------------------------------------------------------

interface Interaction {
  type: number;
  token: string;
  application_id: string;
  data?: { name: string; options?: { name: string; value: string }[] };
  member?: { user?: { id: string } };
  user?: { id: string };
}

type Reply = { content?: string; embeds?: unknown[]; components?: unknown[] };

/**
 * Traite une interaction. Renvoie la réponse immédiate (PONG ou réponse différée) ; le contenu est
 * envoyé ensuite par le webhook de l'interaction.
 */
export function handleInteraction(interaction: Interaction): { type: number; data?: unknown } {
  if (interaction.type === 1) return { type: 1 };
  // Boutons et fenêtres des tickets (services/tickets.ts).
  if (interaction.type === 3 || interaction.type === 5) return handleTicketInteraction(interaction as unknown as TicketInteraction) ?? { type: 4, data: { flags: EPHEMERAL, content: 'Action inconnue.' } };
  if (interaction.type !== 2 || !interaction.data) return { type: 4, data: { flags: EPHEMERAL } };
  const name = interaction.data.name;
  const option = (key: string) => interaction.data?.options?.find((o) => o.name === key)?.value?.trim() ?? '';
  const discordId = interaction.member?.user?.id ?? interaction.user?.id ?? '';
  const ephemeral = name === 'match';
  void (async () => {
    let reply: Reply;
    try {
      reply = await answer(name, option, discordId);
    } catch (caught) {
      console.warn('[discord] commande impossible', name, (caught as Error).message);
      reply = { content: 'Oups, impossible de répondre pour le moment. Réessaie dans un instant.' };
    }
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...reply, allowed_mentions: { parse: [] } }),
    }).catch((caught) => console.warn('[discord] réponse impossible', (caught as Error).message));
  })();
  return { type: 5, data: { flags: ephemeral ? EPHEMERAL : 0 } };
}

async function answer(name: string, option: (key: string) => string, discordId: string): Promise<Reply> {
  switch (name) {
    case 'profil':
      return profile(option('joueur'), discordId);
    case 'classement':
      return option('mode') === 'division' ? divisionTop() : rankedTop();
    case 'equipe':
      return team(option('tag'));
    case 'trophees':
      return cups();
    case 'file':
      return queue();
    case 'match':
      return myMatch(discordId);
    default:
      return links();
  }
}

const button = (label: string, url: string) => ({ type: 2, style: 5, label, url });
const row = (...buttons: unknown[]) => [{ type: 1, components: buttons }];

async function userByDiscord(discordId: string) {
  const { data } = await supabase.from('users').select('id, username, avatar_url').eq('discord_id', discordId).maybeSingle();
  return data as { id: string; username: string; avatar_url: string | null } | null;
}

async function userByName(name: string) {
  const clean = name.replace(/[%_]/g, '');
  for (const pattern of [clean, `${clean}%`, `%${clean}%`]) {
    const { data } = await supabase.from('users').select('id, username, avatar_url').ilike('username', pattern).limit(1);
    if (data?.length) return data[0] as { id: string; username: string; avatar_url: string | null };
  }
  return null;
}

async function profile(name: string, discordId: string): Promise<Reply> {
  const user = name ? await userByName(name) : await userByDiscord(discordId);
  if (!user) return { content: name ? `Aucun joueur trouvé pour « ${name} ».` : `Ton compte Discord n’est pas encore lié : connecte-toi sur ${SITE}.` };
  const [{ data: p }, membership, medals] = await Promise.all([
    supabase.from('cod_profiles').select('points, wins, losses, win_streak, best_streak').eq('user_id', user.id).maybeSingle(),
    supabase.from('team_members').select('team_id').eq('user_id', user.id).maybeSingle(),
    supabase.from('cup_medals').select('place').eq('user_id', user.id),
  ]);
  const stats = (p ?? { points: 0, wins: 0, losses: 0, win_streak: 0, best_streak: 0 }) as { points: number; wins: number; losses: number; win_streak: number; best_streak: number };
  const { count } = await supabase.from('cod_profiles').select('user_id', { count: 'exact', head: true }).gt('points', stats.points);
  const teamId = (membership.data as { team_id: string } | null)?.team_id;
  const teamRow = teamId ? ((await supabase.from('teams').select('name, tag').eq('id', teamId).maybeSingle()).data as { name: string; tag: string } | null) : null;
  const places = ((medals.data ?? []) as { place: string }[]).map((m) => m.place);
  const medalText = places.length ? ['or', 'argent', 'bronze'].map((m) => `${places.filter((x) => x === m).length} ${m}`).join(' · ') : 'Aucune';
  const played = stats.wins + stats.losses;
  const rank = rankOf(stats.points);
  return {
    embeds: [
      {
        color: rank.color,
        author: { name: 'SixSence · Classé' },
        title: `${user.username} · ${rank.name}`,
        url: `${SITE}/cod/profile/${user.id}`,
        description: `**#${(count ?? 0) + 1}** au classement · **${fr(stats.points)} pts**${stats.win_streak >= 2 ? ` · série de ${stats.win_streak} victoires` : ''}`,
        thumbnail: user.avatar_url ? { url: user.avatar_url } : undefined,
        fields: [
          { name: 'Bilan', value: `${stats.wins} V · ${stats.losses} D${played ? ` (${Math.round((stats.wins / played) * 100)} %)` : ''}`, inline: true },
          { name: 'Équipe', value: teamRow ? `[${teamRow.tag}] ${teamRow.name}` : 'Sans équipe', inline: true },
          { name: 'Médailles Anubis', value: medalText, inline: true },
        ],
      },
    ],
    components: row(button('Voir le profil', `${SITE}/cod/profile/${user.id}`)),
  };
}

const MEDALS = ['🥇', '🥈', '🥉'];

async function rankedTop(): Promise<Reply> {
  const { data } = await supabase.from('cod_profiles').select('user_id, points, wins, losses').order('points', { ascending: false }).order('wins', { ascending: false }).limit(10);
  const rows = (data ?? []) as { user_id: string; points: number; wins: number; losses: number }[];
  const { data: users } = rows.length ? await supabase.from('users').select('id, username').in('id', rows.map((r) => r.user_id)) : { data: [] };
  const names = new Map(((users ?? []) as { id: string; username: string }[]).map((u) => [u.id, u.username]));
  const lines = rows.map((r, i) => `${MEDALS[i] ?? `\`${String(i + 1).padStart(2, ' ')}\``} **${names.get(r.user_id) ?? 'Joueur'}** · ${rankOf(r.points).name} · ${fr(r.points)} pts`);
  return {
    embeds: [{ color: GOLD, title: 'Classement · Top 10', url: `${SITE}/cod/leaderboard`, description: lines.join('\n') || 'Aucun joueur classé pour l’instant.' }],
    components: row(button('Classement complet', `${SITE}/cod/leaderboard`)),
  };
}

async function divisionTop(): Promise<Reply> {
  const { data } = await supabase
    .from('teams')
    .select('name, tag, points, wins, losses')
    .is('disbanded_at', null)
    .order('points', { ascending: false })
    .order('wins', { ascending: false })
    .limit(10);
  const rows = (data ?? []) as { name: string; tag: string; points: number; wins: number; losses: number }[];
  const lines = rows.map((t, i) => `${MEDALS[i] ?? `\`${String(i + 1).padStart(2, ' ')}\``} **[${t.tag}] ${t.name}** · ${fr(t.points)} pts · ${t.wins} V ${t.losses} D`);
  return {
    embeds: [{ color: CYAN, title: 'Division · Top 10', url: `${SITE}/cod/equipes`, description: lines.join('\n') || 'Aucune équipe pour l’instant.' }],
    components: row(button('Classement des équipes', `${SITE}/cod/equipes`)),
  };
}

async function team(tag: string): Promise<Reply> {
  const clean = tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
  if (!clean) return { content: 'Indique le tag de l’équipe, par exemple `/equipe SIX`.' };
  const { data } = await supabase.from('teams').select('id, name, tag, color, points, wins, losses, trophies, logo_url').is('disbanded_at', null).ilike('tag', clean).maybeSingle();
  const t = data as { id: string; name: string; tag: string; color: string; points: number; wins: number; losses: number; trophies: { place: string }[] | null; logo_url: string | null } | null;
  if (!t) return { content: `Aucune équipe active avec le tag [${clean.toUpperCase()}].` };
  const [{ count }, members] = await Promise.all([
    supabase.from('teams').select('id', { count: 'exact', head: true }).is('disbanded_at', null).gt('points', t.points),
    supabase.from('team_members').select('user_id, role').eq('team_id', t.id),
  ]);
  const roster = (members.data ?? []) as { user_id: string; role: string }[];
  const { data: users } = roster.length ? await supabase.from('users').select('id, username').in('id', roster.map((m) => m.user_id)) : { data: [] };
  const names = new Map(((users ?? []) as { id: string; username: string }[]).map((u) => [u.id, u.username]));
  const trophies = t.trophies ?? [];
  const gold = trophies.filter((x) => x.place === 'or' || x.place === 'winner').length;
  return {
    embeds: [
      {
        color: parseInt(t.color.slice(1), 16) || CYAN,
        author: { name: 'SixSence · Division' },
        title: `[${t.tag}] ${t.name}`,
        url: `${SITE}/cod/equipes/${t.id}`,
        thumbnail: t.logo_url ? { url: t.logo_url } : undefined,
        description: `**#${(count ?? 0) + 1}** de la Division · **${fr(t.points)} pts** · ${t.wins} V ${t.losses} D`,
        fields: [
          {
            name: `Effectif (${roster.length})`,
            value: roster.map((m) => `${m.role === 'leader' ? '👑 ' : ''}${names.get(m.user_id) ?? 'Joueur'}`).join('\n') || '—',
            inline: true,
          },
          { name: 'Trophées', value: trophies.length ? `${trophies.length} dont ${gold} en or` : 'Aucun', inline: true },
        ],
      },
    ],
    components: row(button('Fiche de l’équipe', `${SITE}/cod/equipes/${t.id}`)),
  };
}

async function cups(): Promise<Reply> {
  const { data } = await supabase
    .from('tournaments')
    .select('id, kind, name, size, team_size, status, starts_at')
    .in('kind', ['horus', 'anubis'])
    .in('status', ['scheduled', 'running'])
    .order('starts_at')
    .limit(6);
  const list = (data ?? []) as { id: string; kind: string; name: string; size: number; team_size: number | null; status: string; starts_at: string }[];
  if (!list.length) return { content: `Aucune coupe prévue pour l’instant. Elles sont annoncées ici et sur ${SITE}/cod/tournoi.` };
  const fields = [];
  for (const cup of list) {
    const anubis = cup.kind === 'anubis';
    const { count } = await supabase.from(anubis ? 'cup_players' : 'tournament_teams').select('tournament_id', { count: 'exact', head: true }).eq('tournament_id', cup.id);
    const capacity = anubis ? cup.size * ((cup.team_size ?? 4) + 1) : cup.size;
    const date = new Date(cup.starts_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    fields.push({
      name: `${anubis ? '𓂀' : '🏆'} ${cup.name}`,
      value:
        cup.status === 'running'
          ? 'En cours : tableau en direct sur le site.'
          : `${date}\n${anubis ? `Solo, équipes de ${cup.team_size} tirées au sort · ${count ?? 0} / ${capacity} inscrits` : `Équipes · ${count ?? 0} / ${capacity} inscrites`}`,
    });
  }
  return {
    embeds: [{ color: GOLD, title: 'Trophées SixSence', url: `${SITE}/cod/tournoi`, fields }],
    components: row(button('Coupe Horus', `${SITE}/cod/tournoi`), button('Coupe Anubis', `${SITE}/cod/tournoi?coupe=anubis`)),
  };
}

async function queue(): Promise<Reply> {
  const [summaries, division, live] = await Promise.all([
    getQueueSummaries(),
    teamStatus(),
    supabase.from('cod_matches').select('id', { count: 'exact', head: true }).in('status', ACTIVE_COD),
  ]);
  const ranked = summaries.map((s) => `**${s.label}** · ${s.size} / ${s.needed}`).join('\n');
  return {
    embeds: [
      {
        color: GOLD,
        title: 'En ce moment sur SixSence',
        fields: [
          { name: 'Classé · joueurs en file', value: ranked || '—', inline: true },
          { name: 'Matchs classés en cours', value: String(live.count ?? 0), inline: true },
          { name: 'Division', value: `${division.teamsSearching} équipe${division.teamsSearching > 1 ? 's' : ''} en recherche\n${division.matchesInProgress} match${division.matchesInProgress > 1 ? 's' : ''} en cours` },
        ],
      },
    ],
    components: row(button('Jouer en Classé', `${SITE}/cod/ranked`), button('File Division', `${SITE}/cod/division`)),
  };
}

async function myMatch(discordId: string): Promise<Reply> {
  const user = await userByDiscord(discordId);
  if (!user) return { content: `Ton compte Discord n’est pas encore lié : connecte-toi sur ${SITE}.` };
  const [cod, teamMatch] = await Promise.all([
    supabase.from('cod_matches').select('id, status').in('status', ACTIVE_COD).or(`team_a.cs.{${user.id}},team_b.cs.{${user.id}}`).limit(1).maybeSingle(),
    supabase.from('team_matches').select('id, status').in('status', ACTIVE_TEAM).or(`roster_a.cs.{${user.id}},roster_b.cs.{${user.id}}`).limit(1).maybeSingle(),
  ]);
  const buttons = [];
  if (cod.data) buttons.push(button('Match classé', `${SITE}/cod/match/${(cod.data as { id: string }).id}`));
  if (teamMatch.data) buttons.push(button('Match de Division', `${SITE}/cod/equipes/match/${(teamMatch.data as { id: string }).id}`));
  if (!buttons.length) return { content: 'Tu n’as aucun match en cours.', components: row(button('Lancer une recherche', `${SITE}/cod/ranked`)) };
  return { content: 'Ton match en cours :', components: row(...buttons) };
}

function links(): Reply {
  return {
    embeds: [{ color: GOLD, title: 'SixSence', description: 'Compétition COD & Événements GTA', url: SITE }],
    components: row(button('Site', SITE), button('Mon profil', `${SITE}/cod/profile`), button('Règlement', `${SITE}/reglement`), button('Trophées', `${SITE}/cod/tournoi`)),
  };
}
