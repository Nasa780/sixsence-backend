import { isReferee } from '../auth.js';
import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { bus, type CodMatch } from '../events.js';
import { supabase } from '../supabase.js';
import type { Role } from '../roles.js';
import { syncCards } from './cards.js';
import { syncRankRoles } from './community.js';
import { correctionWindowHours } from './correctionPolicy.js';
import { noticeMatchCorrected, noticeMatchResolved } from './matchNotices.js';
import { mvpVotesOf, resolveOpenRequests } from './moderation.js';

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

/** Capture d'écran envoyée comme preuve du résultat. */
export interface MatchProof {
  id: number;
  user_id: string;
  username: string;
  url: string;
  created_at: string;
}

/** Points en jeu pour un joueur : gain en cas de victoire, perte en cas de défaite. */
export interface PointsAtStake {
  win: number;
  loss: number;
  /** Bonus de série compris dans win. */
  bonus: number;
  /** Numéro du match de placement (1 à 10), ou null. */
  placement: number | null;
}

/**
 * Points en jeu de chaque joueur d'un match (cod_points_preview) : exactement ceux
 * qu'appliquera cod_finalize_match. Vide si le calcul échoue (affichage seulement).
 */
export async function pointsPreview(matchId: string): Promise<Record<string, PointsAtStake>> {
  const { data, error } = await supabase.rpc('cod_points_preview', { p_match: matchId });
  if (error) {
    console.warn('[points] aperçu indisponible', error.message);
    return {};
  }
  return (data ?? {}) as Record<string, PointsAtStake>;
}

/** Durée de validité des liens vers les captures (bucket privé). */
const PROOF_URL_SECONDS = 60 * 60;

/** Liens temporaires vers les captures du bucket privé des preuves (chemin -> adresse). */
async function proofUrls(paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const { data, error } = await supabase.storage.from('match-proofs').createSignedUrls(paths, PROOF_URL_SECONDS);
  if (error) throw new HttpError(500, 'PROOFS_UNAVAILABLE', 'Captures momentanément indisponibles.');
  const urls = new Map<string, string>();
  for (const item of data ?? []) if (item.path && item.signedUrl) urls.set(item.path, item.signedUrl);
  return urls;
}

/**
 * Renvoie un match, la fiche de ses joueurs, le chat et les preuves.
 *
 * Le chat et les captures ne sont envoyés qu'aux joueurs du match et aux admins
 * (privateAccess) ; les autres visiteurs voient le match, les équipes et le résultat.
 */
export async function getMatch(
  matchId: string,
  viewerId: string | null = null,
): Promise<{
  match: CodMatch;
  players: MatchPlayer[];
  messages: MatchMessage[];
  proofs: MatchProof[];
  privateAccess: boolean;
  mvpVotes: Record<string, number>;
  mvpVotesFromOthers: Record<string, number>;
  /** Points en jeu par joueur, tant que le match n'est pas terminé. */
  pointsAtStake: Record<string, PointsAtStake> | null;
}> {
  const match = unwrap(await supabase.from('cod_matches').select('*').eq('id', matchId).maybeSingle()) as CodMatch | null;
  if (!match) throw new HttpError(404, 'MATCH_NOT_FOUND', 'Match introuvable.');

  const ids = [...match.team_a, ...match.team_b];
  const privateAccess = Boolean(viewerId && (ids.includes(viewerId) || (await isReferee(viewerId))));
  const [users, profiles, messages, proofs] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').in('id', ids),
    supabase.from('cod_profiles').select('user_id, activision_id, platform, points').in('user_id', ids),
    privateAccess
      ? supabase
          .from('cod_match_messages')
          .select('id, user_id, body, created_at')
          .eq('match_id', matchId)
          .order('created_at', { ascending: true })
          .limit(200)
      : { data: [], error: null },
    privateAccess
      ? supabase
          .from('cod_match_proofs')
          .select('id, user_id, storage_path, created_at')
          .eq('match_id', matchId)
          .order('created_at', { ascending: true })
      : { data: [], error: null },
  ]);
  if (users.error) throw fromDbError(users.error);
  if (profiles.error) throw fromDbError(profiles.error);
  if (messages.error) throw fromDbError(messages.error);
  if (proofs.error) throw fromDbError(proofs.error);

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

  const proofRows = (proofs.data ?? []) as { id: number; user_id: string; storage_path: string; created_at: string }[];
  const urls = await proofUrls(proofRows.map((proof) => proof.storage_path));
  const proofList = proofRows
    .filter((proof) => urls.has(proof.storage_path))
    .map((proof) => ({
      id: proof.id,
      user_id: proof.user_id,
      username: nameById.get(proof.user_id) ?? 'Joueur',
      url: urls.get(proof.storage_path) as string,
      created_at: proof.created_at,
    }));

  const finished = match.status === 'completed' || match.status === 'cancelled';
  const [votes, pointsAtStake] = await Promise.all([mvpVotesOf(matchId), finished ? Promise.resolve(null) : pointsPreview(matchId)]);

  return {
    match,
    players,
    messages: chat,
    proofs: proofList,
    privateAccess,
    mvpVotes: votes.total,
    mvpVotesFromOthers: votes.fromOthers,
    pointsAtStake,
  };
}

/** Un joueur accepte le match trouvé (vérification « Prêt ? »). */
export async function readyMatch(matchId: string, userId: string): Promise<CodMatch> {
  return unwrap(await supabase.rpc('cod_ready', { p_match: matchId, p_user: userId })) as CodMatch;
}

/** Enregistre une preuve déjà envoyée par le joueur dans le bucket match-proofs. */
export async function addProof(matchId: string, userId: string, path: string): Promise<void> {
  unwrap(await supabase.rpc('cod_add_proof', { p_match: matchId, p_user: userId, p_path: path }));
}

/** Matchs contestés, du plus ancien au plus récent (administration). */
export async function listDisputes(): Promise<CodMatch[]> {
  return (unwrap(
    await supabase.from('cod_matches').select('*').eq('status', 'disputed').order('reported_at', { ascending: true }).limit(100),
  ) ?? []) as CodMatch[];
}

/** Un joueur du match déclare le vainqueur ('A' ou 'B'). */
export async function reportMatch(matchId: string, userId: string, winner: 'A' | 'B'): Promise<CodMatch> {
  return unwrap(
    await supabase.rpc('cod_report_match', { p_match: matchId, p_user: userId, p_winner: winner }),
  ) as CodMatch;
}

/** L'équipe adverse confirme (accept = true) ou conteste le résultat déclaré. */
export async function confirmMatch(matchId: string, userId: string, accept: boolean): Promise<CodMatch> {
  const match = unwrap(
    await supabase.rpc('cod_confirm_match', { p_match: matchId, p_user: userId, p_accept: accept }),
  ) as CodMatch;
  announceIfClosed(match);
  return match;
}

/** Arbitrage de l'équipe : valide un vainqueur, ou annule le match si winner vaut null. Les joueurs sont prévenus. */
export async function resolveMatch(matchId: string, winner: 'A' | 'B' | null): Promise<CodMatch> {
  const match = unwrap(await supabase.rpc('cod_resolve_match', { p_match: matchId, p_winner: winner })) as CodMatch;
  announceIfClosed(match);
  if (match) void noticeMatchResolved(match);
  return match;
}

/**
 * Correction d'un match terminé par l'équipe (mauvais clic…) : inverser le vainqueur ou annuler.
 * Délai selon le rôle (48 h, admin sans limite). Les joueurs et le salon de l'équipe sont prévenus ;
 * une inversion revalide le match (points, rangs Discord et cartes à jour par « match:finalized »).
 */
export async function correctMatch(matchId: string, staffId: string, role: Role, action: 'swap' | 'cancel', reason: string): Promise<CodMatch> {
  const match = unwrap(
    await supabase.rpc('cod_correct_match', {
      p_match: matchId,
      p_action: action,
      p_staff: staffId,
      p_reason: reason,
      p_max_hours: correctionWindowHours(role),
    }),
  ) as CodMatch;
  bus.emit('match:closed');
  void noticeMatchCorrected(match, staffId);
  void resolveOpenRequests(matchId, staffId, `Résultat corrigé : ${action === 'cancel' ? 'match annulé' : 'vainqueur inversé'}. ${reason.trim()}`);
  if (action === 'cancel') {
    const ids = [...match.team_a, ...match.team_b];
    void syncRankRoles(ids);
    for (const id of ids) void syncCards(id).catch(() => {});
  }
  return match;
}

/** Match terminé ou annulé : prévient le reste du serveur (salons Discord à supprimer, résultat à publier). */
function announceIfClosed(match: CodMatch | null): void {
  if (match && (match.status === 'completed' || match.status === 'cancelled')) bus.emit('match:closed');
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
    bus.emit('match:closed');
  }
}
