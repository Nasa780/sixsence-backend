import { supabase } from '../supabase.js';
import { mustConfirmClassic, mustConfirmTeam, type ClassicMatch, type TeamMatch } from './pendingPolicy.js';
import { membershipOf } from './teams.js';

const countOf = async (query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> => (await query).count ?? 0;

/**
 * Ce qui attend le joueur, pour les pastilles du menu du site : invitations d'équipe, candidatures et défis reçus
 * (Leaders), nouvelles cartes, résultats à confirmer. Des nombres seulement ; une lecture ratée compte pour zéro.
 */
export async function pendingFor(userId: string) {
  const member = await membershipOf(userId);
  const isLeader = Boolean(member && (member.role === 'leader' || member.isOwner));
  const teamId = member?.team_id ?? null;

  const [invites, requests, challenges, cards, classic, team] = await Promise.all([
    member ? 0 : countOf(supabase.from('team_invites').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('kind', 'invite').eq('status', 'pending')),
    isLeader ? countOf(supabase.from('team_invites').select('id', { count: 'exact', head: true }).eq('team_id', teamId!).eq('kind', 'request').eq('status', 'pending')) : 0,
    isLeader ? countOf(supabase.from('team_challenges').select('id', { count: 'exact', head: true }).eq('to_team', teamId!).eq('status', 'pending')) : 0,
    countOf(supabase.from('cod_cards').select('card_key', { count: 'exact', head: true }).eq('user_id', userId).is('seen_at', null)),
    supabase.from('cod_matches').select('team_a, team_b, reported_by').eq('status', 'awaiting_confirmation').or(`team_a.cs.{${userId}},team_b.cs.{${userId}}`),
    teamId
      ? supabase.from('team_matches').select('team_a, team_b, roster_a, roster_b, reported_team').eq('status', 'awaiting_confirmation').or(`team_a.eq.${teamId},team_b.eq.${teamId}`)
      : { data: [] },
  ]);

  const confirm =
    ((classic.data ?? []) as ClassicMatch[]).filter((match) => mustConfirmClassic(match, userId)).length +
    ((team.data ?? []) as TeamMatch[]).filter((match) => mustConfirmTeam(match, userId, teamId!, isLeader)).length;

  return { invites, requests, challenges, cards, confirm };
}
