import { unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { logToDiscord } from './siteLog.js';

/**
 * « Prêt ? » manqués : chaque absent est déjà sanctionné par la base (`cod_apply_strike`, motif ready_check_missed,
 * table privée cod_strikes). Ici : message dans le journal privé Discord à l'annulation du match, et liste pour
 * l'administration (GET /admin/missed-ready, staff et admins).
 */

/** Journal Discord : match annulé faute de « Prêt ? », avec les absents et leur sanction. */
export async function logMissedReady(matchId: string, missing: string[], sanctions: string[]): Promise<void> {
  if (missing.length === 0) return;
  const [match, users] = await Promise.all([
    supabase.from('cod_matches').select('format, team_size, map').eq('id', matchId).maybeSingle(),
    supabase.from('users').select('id, username').in('id', missing),
  ]);
  const m = match.data as { format: string | null; team_size: number; map: string } | null;
  const names = new Map(((users.data ?? []) as { id: string; username: string }[]).map((u) => [u.id, u.username]));
  const list = missing.map((id, index) => `**${names.get(id) ?? 'Joueur'}** (${sanctions[index] ?? 'avertissement'})`).join(', ');
  logToDiscord(`⏱️ Match ${m?.format ?? (m ? `${m.team_size}v${m.team_size}` : '')}${m?.map ? ` sur ${m.map}` : ''} annulé : pas prêt${missing.length > 1 ? 's' : ''} — ${list}.`);
}

/** Derniers « Prêt ? » manqués (administration) : joueur, match, date, nombre de manqués sur 7 jours. */
export async function missedReadyChecks(limit = 50) {
  const rows = (unwrap(
    await supabase.from('cod_strikes').select('id, user_id, match_id, created_at').eq('reason', 'ready_check_missed').order('created_at', { ascending: false }).limit(limit),
  ) ?? []) as { id: number; user_id: string; match_id: string | null; created_at: string }[];
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const matchIds = [...new Set(rows.map((r) => r.match_id).filter(Boolean) as string[])];
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [users, matches, week] = await Promise.all([
    userIds.length ? supabase.from('users').select('id, username, avatar_url').in('id', userIds) : { data: [] },
    matchIds.length ? supabase.from('cod_matches').select('id, format, team_size, map').in('id', matchIds) : { data: [] },
    userIds.length ? supabase.from('cod_strikes').select('user_id').eq('reason', 'ready_check_missed').in('user_id', userIds).gte('created_at', since) : { data: [] },
  ]);
  const userById = new Map(((users.data ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((u) => [u.id, u]));
  const matchById = new Map(((matches.data ?? []) as { id: string; format: string | null; team_size: number; map: string }[]).map((m) => [m.id, m]));
  const weekCount = new Map<string, number>();
  for (const row of (week.data ?? []) as { user_id: string }[]) weekCount.set(row.user_id, (weekCount.get(row.user_id) ?? 0) + 1);
  return rows.map((row) => {
    const user = userById.get(row.user_id);
    const match = row.match_id ? matchById.get(row.match_id) : undefined;
    return {
      id: row.id,
      at: row.created_at,
      player: { id: row.user_id, username: user?.username ?? 'Joueur', avatarUrl: user?.avatar_url ?? null },
      match: match ? { id: row.match_id, format: match.format ?? `${match.team_size}v${match.team_size}`, map: match.map } : null,
      lastWeek: weekCount.get(row.user_id) ?? 0,
    };
  });
}
