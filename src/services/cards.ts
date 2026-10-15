import {
  DEFAULT_CARD,
  MVP_MONTH_CARD,
  STATIC_CARDS,
  canEquip,
  eligibleKeys,
  findCard,
  longestStreak,
  mvpOf,
  revokedKeys,
  seasonCards,
  type CardDef,
  type CardStats,
} from '../cards.js';
import { config } from '../config.js';
import { HttpError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { dm } from './discord.js';
import { pushToUsers } from './push.js';

/**
 * Cartes de visite : statistiques de carrière, déblocage (définitif), retrait de Partenaire
 * et Staff avec le statut, carte équipée (cod_profiles.calling_card).
 * Nouvelle carte : notification push (regroupée) ; Épique ou Légendaire : message privé
 * Discord. Aucune annonce publique. L'attribution rétroactive (silent) ne prévient personne.
 */

interface MatchRow {
  id: string;
  format: string | null;
  team_a: string[];
  team_b: string[];
  winner: 'A' | 'B' | null;
  group_sizes: Record<string, number> | null;
}

/** Statistiques de toute la carrière d'un joueur (toutes saisons). */
export async function computeStats(userId: string): Promise<CardStats & { calling_card: string }> {
  const [profile, user, matches, seasons, mvpMonths, registrations] = await Promise.all([
    supabase.from('cod_profiles').select('peak_points, points, badges, calling_card').eq('user_id', userId).maybeSingle(),
    supabase.from('users').select('role').eq('id', userId).maybeSingle(),
    supabase
      .from('cod_matches')
      .select('id, format, team_a, team_b, winner, group_sizes')
      .eq('status', 'completed')
      .or(`team_a.cs.{${userId}},team_b.cs.{${userId}}`)
      .order('completed_at', { ascending: true })
      .limit(5000),
    supabase.from('season_results').select('season_id, position, points, peak_points, wins, losses').eq('user_id', userId),
    supabase.from('cod_monthly_mvp').select('month').eq('user_id', userId),
    supabase.from('gta_registrations').select('gta_events!inner(starts_at, ends_at, status)').eq('user_id', userId),
  ]);

  const rows = (matches.data ?? []) as MatchRow[];
  const results = rows.map((match) => (match.winner === 'A' ? match.team_a : match.winner === 'B' ? match.team_b : []).includes(userId));
  const won = rows.filter((_, index) => results[index]);

  // MVP : votes des matchs gagnés (le MVP est choisi dans l'équipe gagnante).
  let mvpMatches = 0;
  if (won.length > 0) {
    const { data: votes } = await supabase.from('cod_mvp_votes').select('match_id, voter_id, target_id').in('match_id', won.map((match) => match.id));
    const byMatch = new Map<string, { voter_id: string; target_id: string }[]>();
    for (const vote of (votes ?? []) as { match_id: string; voter_id: string; target_id: string }[]) {
      byMatch.set(vote.match_id, [...(byMatch.get(vote.match_id) ?? []), vote]);
    }
    mvpMatches = [...byMatch.values()].filter((list) => mvpOf(list).includes(userId)).length;
  }

  const seasonRows = (seasons.data ?? []) as { season_id: number; position: number | null; points: number; peak_points: number | null; wins: number; losses: number }[];
  const now = Date.now();
  const gtaEvents = ((registrations.data ?? []) as unknown as { gta_events: { starts_at: string; ends_at: string | null; status: string } | null }[]).filter(
    (row) => row.gta_events && row.gta_events.status !== 'cancelled' && new Date(row.gta_events.ends_at ?? row.gta_events.starts_at).getTime() < now,
  ).length;
  const p = (profile.data ?? {}) as { peak_points?: number; points?: number; badges?: string[]; calling_card?: string };
  const role = (user.data as { role?: string } | null)?.role ?? 'member';

  return {
    peak: Math.max(p.peak_points ?? 0, p.points ?? 0, ...seasonRows.map((row) => Math.max(row.peak_points ?? 0, row.points))),
    wins: won.length,
    played: rows.length,
    bestStreak: longestStreak(results),
    formatsWon: [...new Set(won.map((match) => match.format).filter(Boolean) as string[])],
    groupWins: won.filter((match) => (match.group_sizes?.[userId] ?? 1) > 1).length,
    soloWins: won.filter((match) => (match.group_sizes?.[userId] ?? 1) <= 1).length,
    mvpMatches,
    mvpMonths: ((mvpMonths.data ?? []) as { month: string }[]).map((row) => row.month.slice(0, 7)),
    // Pic de la saison (archivé depuis la migration 0020) ; à défaut, les points de fin de saison.
    seasons: seasonRows.map((row) => ({ id: row.season_id, position: row.position, played: row.wins + row.losses, peak: Math.max(row.peak_points ?? 0, row.points) })),
    badges: p.badges ?? [],
    team: role === 'admin' || role === 'staff' || role === 'arbitre',
    gtaEvents,
    calling_card: p.calling_card ?? DEFAULT_CARD,
  };
}

const RARITY_LABEL = { commune: 'Commune', rare: 'Rare', epique: 'Épique', legendaire: 'Légendaire' } as const;

/** Prévient le joueur de ses nouvelles cartes (push regroupé ; DM pour Épique et Légendaire). */
async function announceCards(userId: string, cards: CardDef[]): Promise<void> {
  if (cards.length === 0) return;
  const url = '/cod/profile?cartes=1';
  await pushToUsers([userId], {
    title: cards.length === 1 ? '🎴 Nouvelle carte de visite' : `🎴 ${cards.length} nouvelles cartes de visite`,
    body:
      cards.length === 1
        ? `${cards[0]!.name} — ${cards[0]!.condition}. Équipe-la depuis ton profil.`
        : `${cards.map((card) => card.name).join(', ')}. Équipe-les depuis ton profil.`,
    url,
    tag: 'cartes',
  });
  const rare = cards.filter((card) => card.rarity === 'epique' || card.rarity === 'legendaire');
  if (rare.length > 0) {
    await dm(
      [userId],
      `${rare.map((card) => `🎴 **Carte ${RARITY_LABEL[card.rarity]} débloquée : ${card.name}** — ${card.condition}.`).join('\n')}\nÉquipe-la depuis ton profil : ${config.siteUrl}${url}`,
    );
  }
}

let seasonCache: { active: number | null; past: number[]; at: number } | null = null;

/** Saison en cours et saisons passées (cache de 5 minutes). */
async function seasonIds(): Promise<{ active: number | null; past: number[] }> {
  if (seasonCache && Date.now() - seasonCache.at < 5 * 60_000) return seasonCache;
  const { data } = await supabase.from('seasons').select('id, is_active').order('id');
  const rows = (data ?? []) as { id: number; is_active: boolean }[];
  seasonCache = { active: rows.find((row) => row.is_active)?.id ?? null, past: rows.filter((row) => !row.is_active).map((row) => row.id), at: Date.now() };
  return seasonCache;
}

/** Saison clôturée : le cache doit être relu. */
export function forgetSeasons(): void {
  seasonCache = null;
}

/**
 * Met à jour les cartes d'un joueur : ajoute celles méritées, retire Partenaire / Staff
 * si le statut est perdu (carte équipée remplacée par la carte par défaut).
 */
export async function syncCards(userId: string, { silent = false } = {}): Promise<{ stats: CardStats & { calling_card: string }; added: string[] }> {
  const stats = await computeStats(userId);
  const eligible = eligibleKeys(stats).filter((key) => key !== DEFAULT_CARD);
  const { data: ownedRows } = await supabase.from('cod_cards').select('card_key').eq('user_id', userId);
  const owned = ((ownedRows ?? []) as { card_key: string }[]).map((row) => row.card_key);

  let added: string[] = [];
  const missing = eligible.filter((key) => !owned.includes(key));
  if (missing.length > 0) {
    const { data } = await supabase
      .from('cod_cards')
      .upsert(missing.map((card_key) => ({ user_id: userId, card_key })), { onConflict: 'user_id,card_key', ignoreDuplicates: true })
      .select('card_key');
    added = ((data ?? []) as { card_key: string }[]).map((row) => row.card_key);
  }

  const revoked = revokedKeys(owned, stats);
  if (revoked.length > 0) {
    await supabase.from('cod_cards').delete().eq('user_id', userId).in('card_key', revoked);
    if (revoked.includes(stats.calling_card)) {
      await supabase.from('cod_profiles').update({ calling_card: DEFAULT_CARD }).eq('user_id', userId);
      stats.calling_card = DEFAULT_CARD;
    }
  }

  if (!silent && added.length > 0) {
    const { past, active } = await seasonIds();
    const ids = [...past, ...(active ? [active] : [])];
    void announceCards(userId, added.map((key) => findCard(key, ids)).filter(Boolean) as CardDef[]).catch(() => {});
  }
  return { stats, added };
}

/** Tous les joueurs (attribution rétroactive au lancement, puis rattrapage périodique). */
export async function syncAllCards({ silent = false } = {}): Promise<number> {
  const { data } = await supabase.from('users').select('id').limit(5000);
  let added = 0;
  for (const { id } of (data ?? []) as { id: string }[]) {
    try {
      added += (await syncCards(id, { silent })).added.length;
    } catch (error) {
      console.warn('[cartes] synchronisation impossible pour un joueur', (error as Error).message);
    }
  }
  return added;
}

/** Collection du joueur pour la fenêtre « Changer de carte ». */
export async function myCards(userId: string) {
  const { stats } = await syncCards(userId);
  const { active, past } = await seasonIds();
  const { data: rows } = await supabase.from('cod_cards').select('card_key, obtained_at, seen_at').eq('user_id', userId);
  const owned = new Map(((rows ?? []) as { card_key: string; obtained_at: string; seen_at: string | null }[]).map((row) => [row.card_key, row]));

  const describe = (card: CardDef, state: { season?: number; unavailable?: boolean } = {}) => {
    const row = owned.get(card.key);
    const isOwned = card.key === DEFAULT_CARD || Boolean(row);
    return {
      key: card.key,
      family: card.family,
      name: card.name,
      condition: card.condition,
      rarity: card.rarity,
      exclusive: Boolean(card.exclusive),
      owned: isOwned,
      isNew: Boolean(row && !row.seen_at),
      obtainedAt: row?.obtained_at ?? null,
      progress: !isOwned && card.progress ? card.progress(stats) : null,
      count: card.key === MVP_MONTH_CARD ? stats.mvpMonths.length : null,
      season: state.season ?? null,
      unavailable: Boolean(state.unavailable && !isOwned),
    };
  };

  const current = [...STATIC_CARDS.map((card) => describe(card)), ...(active ? seasonCards(active).map((card) => describe(card, { season: active })) : [])];
  const previous = past.flatMap((id) => seasonCards(id).map((card) => describe(card, { season: id, unavailable: true })));
  return {
    equipped: stats.calling_card,
    cards: current,
    previousSeasons: previous,
    ownedCount: [...current, ...previous].filter((card) => card.owned).length,
    total: current.length,
    newCount: [...current, ...previous].filter((card) => card.isNew).length,
  };
}

/** Équipe une carte obtenue (ou la carte par défaut). */
export async function equipCard(userId: string, body: unknown): Promise<{ equipped: string }> {
  const key = (body as { key?: unknown } | undefined)?.key;
  if (typeof key !== 'string' || key.length > 60) throw new HttpError(400, 'INVALID_CARD', 'Carte invalide.');
  const { active, past } = await seasonIds();
  if (!findCard(key, [...past, ...(active ? [active] : [])])) throw new HttpError(400, 'INVALID_CARD', 'Carte inconnue.');
  const { data } = await supabase.from('cod_cards').select('card_key').eq('user_id', userId);
  if (!canEquip(key, ((data ?? []) as { card_key: string }[]).map((row) => row.card_key))) {
    throw new HttpError(403, 'CARD_LOCKED', "Tu n'as pas encore débloqué cette carte.");
  }
  unwrap(await supabase.from('cod_profiles').update({ calling_card: key }).eq('user_id', userId));
  return { equipped: key };
}

/** Fenêtre de choix ouverte : les cartes ne sont plus « Nouvelles ». */
export async function markCardsSeen(userId: string): Promise<void> {
  unwrap(await supabase.from('cod_cards').update({ seen_at: new Date().toISOString() }).eq('user_id', userId).is('seen_at', null));
}
