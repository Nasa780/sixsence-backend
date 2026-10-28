import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { bus, type CodMatch } from '../events.js';
import { supabase } from '../supabase.js';
import { readyMatch } from './matches.js';

/**
 * Accepter un match trouvé (« Prêt ? ») hors du site : depuis le bouton du message privé Discord
 * (services/discordCommands.ts) ou depuis le bouton « Accepter » de la notification (service worker du site).
 * Mêmes effets que POST /cod/matches/:id/ready.
 */
export async function acceptReady(matchId: string, userId: string): Promise<CodMatch> {
  const match = await readyMatch(matchId, userId);
  bus.emit(match.status === 'in_progress' && match.started_at && Date.now() - new Date(match.started_at).getTime() < 5000 ? 'match:start' : 'match:ready', match);
  return match;
}

/**
 * « Prêt automatique » (option du profil, cod_profiles.auto_ready) : à la création du match, le serveur accepte le
 * « Prêt ? » des joueurs qui l'ont activée, comme s'ils avaient cliqué. Petit délai pour que les messages « Match trouvé »
 * partent d'abord.
 */
export async function autoAcceptReady(match: CodMatch): Promise<void> {
  const ids = [...match.team_a, ...match.team_b];
  const { data } = await supabase.from('cod_profiles').select('user_id').in('user_id', ids).eq('auto_ready', true);
  const auto = ((data ?? []) as { user_id: string }[]).map((row) => row.user_id);
  if (auto.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const userId of auto) {
    await acceptReady(match.id, userId).catch((caught: Error) => console.warn('[prêt auto]', caught.message));
  }
}

/** Active ou coupe le « Prêt automatique » du joueur. */
export async function setAutoReady(userId: string, body: unknown): Promise<{ autoReady: boolean }> {
  const on = (body as { on?: unknown } | undefined)?.on === true;
  const { error } = await supabase.from('cod_profiles').update({ auto_ready: on }).eq('user_id', userId);
  if (error) throw new HttpError(500, 'AUTO_READY_FAILED', 'Réglage impossible pour le moment.');
  return { autoReady: on };
}

/** Joueur du site lié à un compte Discord. */
export async function userIdFromDiscord(discordId: string): Promise<string | null> {
  const { data } = await supabase.from('users').select('id').eq('discord_id', discordId).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// --- Jeton de la notification ---------------------------------------------------------------
// La notification n'a pas la session du joueur : elle porte un jeton signé (HMAC), valable pour ce
// match, ce joueur et jusqu'à la fin du délai « Prêt ? ». Il ne sert qu'à accepter ce match.

const sign = (payload: string) => createHmac('sha256', `ready:${config.supabaseSecretKey}`).update(payload).digest('base64url');

export function readyToken(matchId: string, userId: string, deadline: string | null): string {
  const until = deadline ? new Date(deadline).getTime() : Date.now() + config.cod.readySeconds * 1000;
  const payload = `${matchId}.${userId}.${until}`;
  return `${userId}.${until}.${sign(payload)}`;
}

export async function acceptWithToken(matchId: string, token: unknown): Promise<CodMatch> {
  const [userId = '', until = '', signature = ''] = typeof token === 'string' ? token.split('.') : [];
  const expected = Buffer.from(sign(`${matchId}.${userId}.${until}`));
  const given = Buffer.from(signature);
  if (!userId || given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(403, 'INVALID_TOKEN', 'Lien d’acceptation invalide.');
  if (Date.now() > Number(until) + 5000) throw new HttpError(409, 'READY_EXPIRED', 'Le délai pour accepter est passé.');
  return acceptReady(matchId, userId);
}
