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
