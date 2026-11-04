import { config } from '../config.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { createChallenge, myLeaderTeam } from './challenges.js';
import { dm } from './discord.js';
import { defiActionId, parseDefiAction, reminderDue } from './discordActionPolicy.js';

/**
 * Commandes Discord qui agissent, pas seulement lisent. /defi : un Leader défie une équipe, choisit ses joueurs dans
 * un menu, l'équipe adverse répond depuis le site, mêmes règles que sur le site (createChallenge). /rappel : message
 * privé 2 h avant une coupe, à l'ouverture du check-in, pour y penser sans y être inscrit (migration 0063).
 */

const SITE = config.siteUrl;
const NOT_LINKED = `Ton compte Discord n’est lié à aucun joueur : connecte-toi une fois sur ${SITE}.`;

type Reply = { content: string; components?: unknown[] };

async function linkedUser(discordId: string): Promise<string | null> {
  const { data } = await supabase.from('users').select('id').eq('discord_id', discordId).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// --- /defi --------------------------------------------------------------------------------------

export async function defiCommand(tag: string, type: string, discordId: string): Promise<Reply> {
  if (!config.teams.enabled) return { content: 'La Division est en pause.' };
  const userId = await linkedUser(discordId);
  if (!userId) return { content: NOT_LINKED };
  let myTeam: string;
  try {
    myTeam = await myLeaderTeam(userId);
  } catch (caught) {
    if (caught instanceof HttpError) return { content: caught.message };
    throw caught;
  }
  const clean = tag.replace(/[^A-Za-z0-9]/g, '').slice(0, 4);
  const { data: target } = await supabase.from('teams').select('id, name, tag').is('disbanded_at', null).is('cup_tournament', null).ilike('tag', clean || '-').maybeSingle();
  const opponent = target as { id: string; name: string; tag: string } | null;
  if (!opponent) return { content: `Aucune équipe active avec le tag [${clean.toUpperCase()}].` };
  if (opponent.id === myTeam) return { content: 'Tu ne peux pas défier ta propre équipe.' };

  const size = config.teams.rosterSize;
  const members = unwrap(await supabase.from('team_members').select('user_id').eq('team_id', myTeam)) as { user_id: string }[];
  if (members.length < size) return { content: `Il faut ${size} joueurs dans ton équipe pour lancer un défi : vous êtes ${members.length}.` };
  const users = unwrap(await supabase.from('users').select('id, username').in('id', members.map((m) => m.user_id))) as { id: string; username: string }[];

  const friendly = type !== 'officiel';
  return {
    content: `⚔️ Défi ${friendly ? 'amical' : 'officiel'} contre **[${opponent.tag}] ${opponent.name}** : choisis les ${size} joueurs du match.`,
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: defiActionId(opponent.id, friendly),
            placeholder: `${size} joueurs`,
            min_values: size,
            max_values: size,
            options: users.slice(0, 25).map((user) => ({ label: user.username.slice(0, 100), value: user.id })),
          },
        ],
      },
    ],
  };
}

/** Menu des joueurs validé : le défi part avec les règles du site. Renvoie le texte de la réponse, ou null si l'identifiant est inconnu. */
export async function defiSelected(customId: unknown, values: unknown, discordId: string): Promise<string | null> {
  const action = parseDefiAction(customId);
  if (!action) return null;
  const userId = await linkedUser(discordId);
  if (!userId) return NOT_LINKED;
  try {
    await createChallenge(userId, { teamId: action.teamId, friendly: action.friendly, roster: values });
    return `⚔️ Défi envoyé. Les Leaders adverses sont prévenus et répondent depuis le site : ${SITE}/cod/equipe?onglet=defis`;
  } catch (caught) {
    if (caught instanceof HttpError) return caught.message;
    throw caught;
  }
}

// --- /rappel ------------------------------------------------------------------------------------

const dateOf = (iso: string) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Active le rappel de la prochaine coupe (Horus, Anubis ou la plus proche), ou le retire s'il est déjà actif. */
export async function rappelCommand(kind: string, discordId: string): Promise<Reply> {
  const userId = await linkedUser(discordId);
  if (!userId) return { content: NOT_LINKED };
  const kinds = kind === 'horus' || kind === 'anubis' ? [kind] : ['horus', 'anubis'];
  const { data: found } = await supabase
    .from('tournaments')
    .select('id, name, starts_at')
    .in('kind', kinds)
    .eq('status', 'scheduled')
    .gt('starts_at', new Date().toISOString())
    .order('starts_at')
    .limit(1)
    .maybeSingle();
  const cup = found as { id: string; name: string; starts_at: string } | null;
  if (!cup) return { content: `Aucune coupe prévue pour l’instant. Elles sont annoncées ici et sur ${SITE}/cod/tournoi.` };

  const { data: existing } = await supabase.from('cup_reminders').select('sent_at').eq('tournament_id', cup.id).eq('user_id', userId).maybeSingle();
  const reminder = existing as { sent_at: string | null } | null;
  if (reminder?.sent_at) return { content: `Le rappel de **${cup.name}** t’a déjà été envoyé.` };
  if (reminder) {
    unwrap(await supabase.from('cup_reminders').delete().eq('tournament_id', cup.id).eq('user_id', userId).select('user_id'));
    return { content: `🔕 Rappel retiré pour **${cup.name}**.` };
  }
  unwrap(await supabase.from('cup_reminders').insert({ tournament_id: cup.id, user_id: userId }).select('user_id'));
  return { content: `⏰ C’est noté : message privé 2 h avant **${cup.name}** (${dateOf(cup.starts_at)}). Refais \`/rappel\` pour l’annuler.` };
}

/** Envoie les rappels arrivés à l'heure (index.ts, toutes les 5 minutes). Chaque rappel est réservé avant l'envoi. */
export async function sendCupReminders(now = Date.now()): Promise<void> {
  const { data } = await supabase.from('cup_reminders').select('tournament_id, user_id, tournaments!inner(name, starts_at, status)').is('sent_at', null).eq('tournaments.status', 'scheduled').limit(200);
  const rows = (data ?? []) as unknown as { tournament_id: string; user_id: string; tournaments: { name: string; starts_at: string } }[];
  for (const row of rows) {
    if (!reminderDue(row.tournaments.starts_at, now)) continue;
    const { data: claimed } = await supabase.from('cup_reminders').update({ sent_at: new Date(now).toISOString() }).eq('tournament_id', row.tournament_id).eq('user_id', row.user_id).is('sent_at', null).select('user_id').maybeSingle();
    if (!claimed) continue;
    const time = new Date(row.tournaments.starts_at).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    await dm([row.user_id], `⏰ **${row.tournaments.name}** commence à ${time}. Le check-in est ouvert jusqu’à 15 minutes avant le début : ${SITE}/cod/tournoi?id=${row.tournament_id}`);
  }
}
