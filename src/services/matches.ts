import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import type { CodMatch } from '../events.js';
import { supabase } from '../supabase.js';

/** Joueur tel qu'affiché dans la salle de match. */
export interface MatchPlayer {
  id: string;
  username: string;
  avatar_url: string | null;
  activision_id: string | null;
  platform: string | null;
  points: number;
}

/** Message du chat de match, avec le pseudo de son auteur. */
export interface MatchMessage {
  id: number;
  user_id: string;
  username: string;
  body: string;
  created_at: string;
}

interface UserRow {
  id: string;
  username: string;
  avatar_url: string | null;
}

interface ProfileRow {
  user_id: string;
  activision_id: string | null;
  platform: string | null;
  points: number;
}

/** Renvoie un match, la fiche de ses joueurs et les derniers messages du chat. */
export async function getMatch(
  matchId: string,
): Promise<{ match: CodMatch; players: MatchPlayer[]; messages: MatchMessage[] }> {
  const match = unwrap(await supabase.from('cod_matches').select('*').eq('id', matchId).maybeSingle()) as CodMatch | null;
  if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');

  const ids = [...match.team_a, ...match.team_b];
  const [users, profiles, messages] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').in('id', ids),
    supabase.from('cod_profiles').select('user_id, activision_id, platform, points').in('user_id', ids),
    supabase
      .from('cod_match_messages')
      .select('id, user_id, body, created_at')
      .eq('match_id', matchId)
      .order('created_at', { ascending: true })
      .limit(200),
  ]);
  if (users.error) throw fromDbError(users.error);
  if (profiles.error) throw fromDbError(profiles.error);
  if (messages.error) throw fromDbError(messages.error);

  const userRows = (users.data ?? []) as UserRow[];
  const profileById = new Map(((profiles.data ?? []) as ProfileRow[]).map((profile) => [profile.user_id, profile]));
  const nameById = new Map(userRows.map((user) => [user.id, user.username]));

  const players: MatchPlayer[] = userRows.map((user) => {
    const profile = profileById.get(user.id);
    return {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      activision_id: profile?.activision_id ?? null,
      platform: profile?.platform ?? null,
      points: profile?.points ?? 0,
    };
  });

  const chat = ((messages.data ?? []) as Omit<MatchMessage, 'username'>[]).map((message) => ({
    ...message,
    username: nameById.get(message.user_id) ?? 'Joueur',
  }));

  return { match, players, messages: chat };
}

/** Un joueur du match déclare le vainqueur ('A' ou 'B'). */
export async function reportMatch(matchId: string, userId: string, winner: 'A' | 'B'): Promise<CodMatch> {
  return unwrap(
    await supabase.rpc('cod_report_match', { p_match: matchId, p_user: userId, p_winner: winner }),
  ) as CodMatch;
}

/** L'équipe adverse confirme (accept = true) ou conteste le résultat déclaré. */
export async function confirmMatch(matchId: string, userId: string, accept: boolean): Promise<CodMatch> {
  return unwrap(
    await supabase.rpc('cod_confirm_match', { p_match: matchId, p_user: userId, p_accept: accept }),
  ) as CodMatch;
}

/** Arbitrage admin : valide un vainqueur, ou annule le match si winner vaut null. */
export async function resolveMatch(matchId: string, winner: 'A' | 'B' | null): Promise<CodMatch> {
  return unwrap(await supabase.rpc('cod_resolve_match', { p_match: matchId, p_winner: winner })) as CodMatch;
}

/** Message dans le chat du match (joueurs du match uniquement, vérifié en SQL). */
export async function postMessage(matchId: string, userId: string, body: string): Promise<void> {
  unwrap(await supabase.rpc('cod_post_message', { p_match: matchId, p_user: userId, p_body: body }));
}

/**
 * Ménage périodique : valide les résultats restés sans réponse et annule les
 * matchs abandonnés, pour qu'aucun joueur ne reste bloqué hors de la file.
 */
export async function sweepMatches(): Promise<void> {
  const { data, error } = await supabase.rpc('cod_sweep_matches', {
    p_confirm_minutes: config.cod.confirmMinutes,
    p_cancel_minutes: config.cod.cancelMinutes,
  });
  if (error) {
    console.error('[sweep]', error.message);
    return;
  }
  if (typeof data === 'number' && data > 0) {
    console.log(`[sweep] ${data} match(s) clôturé(s) automatiquement`);
  }
}
