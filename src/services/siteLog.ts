import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { SUPPRESS_EMBEDS, discord, discordEnabled } from './discord.js';

/**
 * Journal du site sur Discord, dans un salon privé (DISCORD_LOGS_CHANNEL_ID, sinon celui de l'équipe) :
 * nouveaux inscrits, équipes créées, et chaque matin le bilan de la veille (visiteurs, inscrits,
 * équipes, matchs). Les visiteurs sont comptés avec l'identifiant aléatoire du compteur « En ligne ».
 */

const channelId = config.discord.logsChannelId || config.discord.staffChannelId;

/** Message dans le salon des journaux (au mieux : une erreur Discord ne bloque rien). */
export function logToDiscord(content: string): void {
  if (!discordEnabled || !channelId) return;
  void discord(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: { content: content.slice(0, 1900), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS },
  }).catch((error: unknown) => console.warn('[journal] envoi impossible', (error as Error).message));
}

/** Date du jour à Paris (AAAA-MM-JJ), éventuellement décalée de quelques jours. */
export function parisDay(now = Date.now(), offsetDays = 0): string {
  return new Date(now + offsetDays * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
}

let today = '';
const seenToday = new Set<string>();

/** Visiteur vu aujourd'hui : enregistré une seule fois par jour. */
export function recordVisit(visitorId: string): void {
  const day = parisDay();
  if (day !== today) {
    today = day;
    seenToday.clear();
  }
  if (seenToday.has(visitorId) || seenToday.size >= 100_000) return;
  seenToday.add(visitorId);
  void supabase
    .from('site_visits')
    .upsert({ day, visitor: visitorId }, { onConflict: 'day,visitor', ignoreDuplicates: true })
    .then(({ error }) => error && console.warn('[journal] visite non enregistrée', error.message));
}

/** Bilan de la veille, publié une fois par jour à partir de 8 h (heure de Paris). */
export async function postDailyReport(now = Date.now()): Promise<void> {
  if (!discordEnabled || !channelId) return;
  const hour = Number(new Date(now).toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
  if (hour < 8) return;
  const day = parisDay(now, -1);
  const { data: first } = await supabase.rpc('app_claim', { p_key: 'daily_report', p_value: day });
  if (!first) return;
  const { data, error } = await supabase.rpc('site_daily_report', { p_day: day });
  if (error) {
    console.warn('[journal] bilan impossible', error.message);
    return;
  }
  const report = data as { visitors: number; signups: number; teams: number; ranked: number; division: number };
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  logToDiscord(
    `📊 **Bilan du ${label}**\n` +
      `👀 ${report.visitors} visiteur(s)\n` +
      `🆕 ${report.signups} inscrit(s)\n` +
      `🛡️ ${report.teams} équipe(s) créée(s)\n` +
      `🎯 ${report.ranked} match(s) classé(s) · ⚔️ ${report.division} match(s) de Division`,
  );
  await supabase.from('site_visits').delete().lt('day', parisDay(now, -90));
}
