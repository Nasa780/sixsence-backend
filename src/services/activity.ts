import { unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { summarize, type ActivityDay, type ActivityPeriod, type Trend } from './activityPolicy.js';
import { parisDay } from './siteLog.js';

/**
 * Tableau de bord de l'activité (GET /admin/activity, admin) : visiteurs, inscrits et matchs jour par jour, comparés
 * à la période précédente, parcours d'un joueur (inscrit, Activision, premier match, régulier), équipes et heures de
 * jeu. Le calcul vit dans la fonction SQL site_activity (migration 0061). Les visiteurs sont gardés 90 jours.
 */
interface SiteActivity {
  days: ActivityDay[];
  activePlayers: Trend;
  hours: { hour: number; matches: number }[];
  funnel: { players: number; activision: number; played: number; regular: number };
  community: { teams: number; fullTeams: number; teamPlayers: number; twitch: number; clips: number };
}

export async function activityReport(period: ActivityPeriod) {
  const data = unwrap(await supabase.rpc('site_activity', { p_today: parisDay(), p_days: period })) as SiteActivity;
  const { days, trends } = summarize(data.days, period);
  return { period, days, trends: { ...trends, activePlayers: data.activePlayers }, hours: data.hours, funnel: data.funnel, community: data.community };
}
