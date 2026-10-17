import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { supabase } from '../supabase.js';
import { discord, discordEnabled } from './discord.js';

/**
 * Règlement du serveur Discord, publié par le bot dans DISCORD_RULES_CHANNEL_ID (bouton de l'admin).
 * Le message publié est retenu (app_state « discord_rules_message ») : un nouveau clic le met à jour
 * au lieu d'en poster un autre. Règles du serveur seulement : celles du classé viendront au lancement
 * de la saison.
 */

const GOLD = 0xd4af37;
const STATE_KEY = 'discord_rules_message';

export const RULES_EMBEDS = [
  {
    title: '📜 RÈGLEMENT SIXSENCE',
    description:
      'Bienvenue sur le serveur officiel de SixSence, la plateforme compétitive Call of Duty et GTA 6.\nEn restant sur le serveur, tu acceptes ce règlement.',
  },
  {
    title: '1 · Respect',
    description: [
      '• Aucune insulte, provocation, discrimination ni harcèlement, en vocal comme à l’écrit.',
      '• Pas de contenu choquant, NSFW ou illégal.',
      '• Pas de spam, de mentions abusives ni de publicité sans l’accord du staff.',
      '• Les débats restent courtois : on règle un conflit en message privé ou avec le staff, pas en public.',
    ].join('\n'),
  },
  {
    title: '2 · Compte et identité',
    description: [
      '• Un seul compte par membre.',
      '• Interdits : se faire passer pour un autre membre ou pour le staff, prêter son compte.',
      '• Pseudo et photo de profil corrects, sans contenu offensant.',
    ].join('\n'),
  },
  {
    title: '3 · Salons',
    description: [
      '• Chaque salon a son sujet : poste au bon endroit.',
      '• En vocal : pas de cris, de musique imposée ni de soundboard abusif.',
      '• Les liens douteux et les fichiers suspects sont interdits.',
    ].join('\n'),
  },
  {
    title: '4 · Sanctions',
    description: [
      '• Selon la gravité : avertissement, mise en sourdine, expulsion ou bannissement.',
      '• Les décisions du staff s’appliquent. Une contestation se fait calmement, en message privé à un membre du staff.',
    ].join('\n'),
  },
  {
    title: '5 · Staff et contact',
    description: [
      '• Les rôles **Staff 6** et **Arbitre 6** encadrent le serveur.',
      '• Une question ou un problème ? Contacte un membre du staff en message privé.',
      '• Le règlement du classé sera publié au lancement de la saison.',
      '',
      '*Bon jeu à tous. ⚡*',
    ].join('\n'),
  },
].map((embed) => ({ ...embed, color: GOLD }));

/** Publie le règlement, ou met à jour le message déjà publié. Renvoie l'action faite. */
export async function publishRules(): Promise<{ action: 'posted' | 'updated'; channelId: string }> {
  const channelId = config.discord.rulesChannelId;
  if (!discordEnabled || !channelId) throw new HttpError(409, 'DISCORD_DISABLED', 'Le bot Discord ou le salon du règlement n’est pas configuré.');
  const { data } = await supabase.from('app_state').select('value').eq('key', STATE_KEY).maybeSingle();
  const previous = (data as { value: string } | null)?.value ?? null;
  const body = { embeds: RULES_EMBEDS, allowed_mentions: { parse: [] } };

  if (previous) {
    const [savedChannel, messageId] = previous.split(':');
    if (savedChannel === channelId && messageId) {
      try {
        await discord(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body });
        return { action: 'updated', channelId };
      } catch {
        // Message supprimé à la main : on le republie.
      }
    }
  }
  try {
    const posted = (await discord(`/channels/${channelId}/messages`, { method: 'POST', body })) as { id: string };
    await supabase.from('app_state').upsert({ key: STATE_KEY, value: `${channelId}:${posted.id}` });
    return { action: 'posted', channelId };
  } catch (caught) {
    throw new HttpError(502, 'DISCORD_ERROR', `Publication impossible : vérifie que le bot peut écrire dans le salon (${(caught as Error).message}).`);
  }
}
