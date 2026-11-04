import { PASS_BADGES, PASS_CARDS, PASS_SEASON, PASS_TIERS, PASS_TIER_XP, passLevel } from '../cards.js';
import { unwrap } from '../errors.js';
import { supabase } from '../supabase.js';

/**
 * Pass de saison gratuit (GET /cod/pass, jeton facultatif) : 30 paliers de 500 XP, gagnés en jouant, cartes de visite
 * et badges attribués tout seuls (syncCards de services/cards.ts). Il court jusqu'à la clôture de la saison.
 */
export async function seasonPass(viewerId: string | null) {
  const season = unwrap(await supabase.from('seasons').select('id, name, ends_at').eq('is_active', true).maybeSingle()) as { id: number; name: string; ends_at: string | null } | null;
  if (!season || season.id !== PASS_SEASON) return { active: false as const };

  let me: { xp: number; level: number; cards: string[]; badges: string[] } | null = null;
  if (viewerId) {
    const [profile, cards] = await Promise.all([
      supabase.from('cod_profiles').select('xp, pass_xp_base, badges').eq('user_id', viewerId).maybeSingle(),
      supabase.from('cod_cards').select('card_key').eq('user_id', viewerId).in('card_key', PASS_CARDS.map((card) => card.key)),
    ]);
    const row = profile.data as { xp: number; pass_xp_base: number; badges: string[] | null } | null;
    const xp = Math.max(0, (row?.xp ?? 0) - (row?.pass_xp_base ?? 0));
    const keys = PASS_BADGES.map((badge) => badge.key);
    me = { xp, level: passLevel(xp), cards: ((cards.data ?? []) as { card_key: string }[]).map((card) => card.card_key), badges: (row?.badges ?? []).filter((badge) => keys.includes(badge)) };
  }

  return {
    active: true as const,
    season: { id: season.id, name: season.name, endsAt: season.ends_at },
    tierXp: PASS_TIER_XP,
    tiers: PASS_TIERS,
    rewards: [
      ...PASS_CARDS.map((card) => ({ level: card.level, kind: 'card' as const, key: card.key, name: card.name, rarity: card.rarity })),
      ...PASS_BADGES.map((badge) => ({ level: badge.level, kind: 'badge' as const, key: badge.key, name: badge.name, rarity: null })),
    ].sort((a, b) => a.level - b.level),
    me,
  };
}
