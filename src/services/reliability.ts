import { supabase } from '../supabase.js';
import { notifyStaff } from './discord.js';

/**
 * Score de fiabilité d'un joueur (GET /cod/players/:id/reliability), sur 100, affiché sur le profil, sans
 * effet sur la file pour l'instant. Calculé sur les 60 derniers jours :
 *   - « Prêt ? » manqué ou autre avertissement : -6 chacun ;
 *   - forfait perdu en Division (équipe du joueur, joueur du match) : -8 ;
 *   - match classé corrigé contre son équipe (résultat déclaré faux) : -10 ;
 *   - +1 par match terminé sans incident (dans la limite de 100).
 *
 * Contrôle anti-smurf (POST /cod/smurf-check) : le site lit le niveau du compte COD sur une capture ;
 * un niveau très bas avec un rang élevé prévient le salon staff, une fois par joueur et par jour.
 */

const WINDOW = 60 * 86_400_000;

export async function reliability(userId: string) {
  const since = new Date(Date.now() - WINDOW).toISOString();
  const [strikes, codMatches, teamMatches] = await Promise.all([
    supabase.from('cod_strikes').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since),
    supabase
      .from('cod_matches')
      .select('id, team_a, team_b, winner, correction_action, status')
      .in('status', ['completed', 'cancelled'])
      .gte('created_at', since)
      .or(`team_a.cs.{${userId}},team_b.cs.{${userId}}`)
      .limit(500),
    supabase
      .from('team_matches')
      .select('id, roster_a, roster_b, winner, forfeit, status')
      .eq('status', 'completed')
      .gte('created_at', since)
      .or(`roster_a.cs.{${userId}},roster_b.cs.{${userId}}`)
      .limit(500),
  ]);
  const cod = (codMatches.data ?? []) as { team_a: string[]; winner: 'A' | 'B' | null; correction_action: string | null; status: string }[];
  const team = (teamMatches.data ?? []) as { roster_a: string[]; winner: 'A' | 'B' | null; forfeit: boolean }[];
  // Correction « swap » : le vainqueur déclaré a été inversé ; pénalise l'équipe désormais perdante.
  const corrected = cod.filter((m) => m.correction_action === 'swap' && m.status === 'completed' && m.winner !== (m.team_a.includes(userId) ? 'A' : 'B')).length;
  const forfeits = team.filter((m) => m.forfeit && m.winner !== (m.roster_a.includes(userId) ? 'A' : 'B')).length;
  const clean = cod.filter((m) => m.status === 'completed' && !m.correction_action).length + team.filter((m) => !m.forfeit).length;
  const warnings = strikes.count ?? 0;
  const score = Math.max(0, Math.min(100, 100 - warnings * 6 - forfeits * 8 - corrected * 10 + clean));
  return {
    score,
    level: score >= 90 ? 'excellent' : score >= 75 ? 'bon' : score >= 60 ? 'moyen' : 'faible',
    details: { warnings, forfeits, corrected, clean },
    windowDays: 60,
  };
}

/** Signal anti-smurf : niveau du compte lu sur la capture du profil COD. */
export async function smurfCheck(userId: string, body: unknown) {
  const level = Number((body as { level?: unknown } | undefined)?.level);
  if (!Number.isInteger(level) || level < 1 || level > 10000) return { ok: true };
  const [{ data: profile }, { data: user }] = await Promise.all([
    supabase.from('cod_profiles').select('points, wins, losses, activision_id').eq('user_id', userId).maybeSingle(),
    supabase.from('users').select('username').eq('id', userId).maybeSingle(),
  ]);
  const p = profile as { points: number; wins: number; losses: number; activision_id: string | null } | null;
  if (!p) return { ok: true };
  // Compte COD très récent (niveau bas) mais déjà haut classé : à regarder par le staff.
  const suspicious = level <= 30 && (p.points >= 900 || (p.wins >= 10 && p.wins / Math.max(1, p.wins + p.losses) >= 0.85));
  if (suspicious) {
    const day = new Date().toISOString().slice(0, 10);
    const { data: first } = await supabase.rpc('app_claim', { p_key: `smurf:${userId}`, p_value: day });
    if (first) {
      await notifyStaff(
        `🕵️ Contrôle anti-smurf : **${(user as { username: string } | null)?.username ?? 'Un joueur'}** (${p.activision_id ?? 'ID inconnu'}) a un compte COD niveau ${level} pour ${p.points} pts (${p.wins} V / ${p.losses} D). À vérifier, aucune sanction automatique.`,
      );
    }
  }
  return { ok: true };
}
