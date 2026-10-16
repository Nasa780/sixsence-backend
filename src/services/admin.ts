import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';
import { openCounts } from './moderation.js';

/**
 * Validation des formulaires de l'administration. Chaque fonction renvoie un
 * objet prêt à écrire en base, ou lève une erreur 400 lisible.
 */

type Input = Record<string, unknown>;
const invalid = (message: string) => new HttpError(400, 'INVALID_INPUT', message);

function text(input: Input, key: string, max: number, required = false): string | null {
  const value = input[key];
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(`Le champ « ${key} » est obligatoire.`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) throw invalid(`Champ invalide : ${key} (${max} caractères au plus).`);
  return value.trim();
}

function httpsUrl(input: Input, key: string, pattern = /^https:\/\//i): string | null {
  const value = text(input, key, 500);
  if (value && !pattern.test(value)) throw invalid(`Le champ « ${key} » doit être une adresse https valide.`);
  return value;
}

function integer(input: Input, key: string, fallback: number): number {
  const value = input[key];
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || Math.abs(parsed) > 100_000) throw invalid(`Nombre invalide : ${key}.`);
  return parsed;
}

/** Ne garde que les clés présentes dans la requête (mise à jour partielle). */
function only<T extends Record<string, unknown>>(full: T, input: Input): Partial<T> {
  return Object.fromEntries(Object.entries(full).filter(([key]) => key in input)) as Partial<T>;
}

// --- Fondateurs -----------------------------------------------------------------

export function parseFounder(body: unknown, partial = false) {
  const input = (body ?? {}) as Input;
  const founder = {
    name: text(input, 'name', 60, !partial),
    role: text(input, 'role', 60, !partial),
    bio: text(input, 'bio', 1000),
    avatar_url: httpsUrl(input, 'avatar_url'),
    steam_url: httpsUrl(input, 'steam_url', /^https:\/\/steamcommunity\.com\//i),
    discord_tag: text(input, 'discord_tag', 60),
    sort_order: integer(input, 'sort_order', 0),
  };
  return partial ? only(founder, input) : founder;
}

// --- Partenaires ----------------------------------------------------------------

const TIERS = ['platinum', 'gold', 'silver', 'community'];

export function parsePartner(body: unknown, partial = false) {
  const input = (body ?? {}) as Input;
  const tier = text(input, 'tier', 20) ?? 'community';
  if (!TIERS.includes(tier)) throw invalid('Niveau de partenariat invalide.');
  const partner = {
    name: text(input, 'name', 80, !partial),
    tier,
    description: text(input, 'description', 1000),
    logo_url: httpsUrl(input, 'logo_url'),
    website_url: httpsUrl(input, 'website_url'),
    sort_order: integer(input, 'sort_order', 0),
  };
  return partial ? only(partner, input) : partner;
}

// --- Événements (mise à jour partielle ; la création réutilise parseNewEvent) ---

export function parseEventPatch(body: unknown) {
  const input = (body ?? {}) as Input;
  const patch: Record<string, unknown> = {};
  if ('title' in input) {
    const title = text(input, 'title', 120, true) as string;
    if (title.length < 3) throw invalid('Le titre doit contenir au moins 3 caractères.');
    patch.title = title;
  }
  if ('description' in input) patch.description = text(input, 'description', 5000);
  if ('category' in input) patch.category = text(input, 'category', 40) ?? 'session';
  if ('location' in input) patch.location = text(input, 'location', 200);
  if ('cover_url' in input) patch.cover_url = httpsUrl(input, 'cover_url');
  for (const key of ['starts_at', 'ends_at']) {
    if (key in input) {
      const value = input[key];
      if (value === null || value === '') {
        if (key === 'starts_at') throw invalid('La date de début est obligatoire.');
        patch[key] = null;
      } else {
        const date = typeof value === 'string' ? new Date(value) : null;
        if (!date || Number.isNaN(date.getTime())) throw invalid(`Date invalide : ${key}.`);
        patch[key] = date.toISOString();
      }
    }
  }
  if ('max_slots' in input) {
    const value = input.max_slots;
    if (value === null || value === '') patch.max_slots = null;
    else {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) throw invalid('Nombre de places invalide.');
      patch.max_slots = parsed;
    }
  }
  if ('status' in input) {
    if (!['draft', 'published', 'cancelled'].includes(String(input.status))) throw invalid('Statut invalide.');
    patch.status = input.status;
  }
  return patch;
}

// --- Joueurs --------------------------------------------------------------------

/** Badges attribuables à la main (les badges de saison s<id>-… sont posés par la clôture). */
export const STAFF_BADGES = ['founder', 'beta', 'partner', 'staff', 'mvp'];
const BADGE_PATTERN = /^(founder|beta|partner|staff|mvp|s\d+-(top10|champion)|mvp-\d{4}-\d{2})$/;

export function parseBadges(body: unknown): string[] {
  const badges = (body as { badges?: unknown } | null)?.badges;
  if (!Array.isArray(badges) || badges.length > 30 || !badges.every((badge) => typeof badge === 'string' && BADGE_PATTERN.test(badge))) {
    throw invalid('Liste de badges invalide.');
  }
  return [...new Set(badges as string[])];
}

export async function searchPlayers(query: string) {
  let request = supabase.from('users').select('id, username, avatar_url, role, created_at').order('username').limit(20);
  const term = query.trim().slice(0, 40).replace(/[%_,()]/g, '');
  if (term) request = request.ilike('username', `%${term}%`);
  const users = (unwrap(await request) ?? []) as { id: string }[];
  if (users.length === 0) return [];

  const { data: profiles, error } = await supabase
    .from('cod_profiles')
    .select('user_id, points, wins, losses, badges, banned_until, activision_id')
    .in('user_id', users.map((user) => user.id));
  if (error) throw fromDbError(error);
  const byId = new Map(((profiles ?? []) as { user_id: string }[]).map((profile) => [profile.user_id, profile]));
  return users.map((user) => ({ ...user, profile: byId.get(user.id) ?? null }));
}

/** Vue d'ensemble du tableau de bord. */
export async function overview() {
  const now = new Date().toISOString();
  const [disputes, players, upcoming, season, banned, cases] = await Promise.all([
    supabase.from('cod_matches').select('id', { count: 'exact', head: true }).eq('status', 'disputed'),
    supabase.from('users').select('id', { count: 'exact', head: true }),
    supabase.from('gta_events').select('id', { count: 'exact', head: true }).gte('starts_at', now).neq('status', 'cancelled'),
    supabase.from('seasons').select('id, name, starts_at').eq('is_active', true).maybeSingle(),
    supabase.from('cod_profiles').select('user_id', { count: 'exact', head: true }).gt('banned_until', now),
    openCounts(),
  ]);
  return {
    disputes: disputes.count ?? 0,
    players: players.count ?? 0,
    upcomingEvents: upcoming.count ?? 0,
    bannedPlayers: banned.count ?? 0,
    openArbitrations: cases.arbitrations,
    openReports: cases.reports,
    season: season.data ?? null,
  };
}

/**
 * Matchs récents pour l'équipe (« Matchs » de /admin) : les 50 derniers, ou ceux d'un joueur
 * (recherche par pseudo), avec les pseudos, la correction éventuelle et les demandes en attente.
 */
export async function recentMatches(query: string) {
  let request = supabase
    .from('cod_matches')
    .select('id, status, map, mode, format, team_size, team_a, team_b, winner, points_changes, created_at, completed_at, cancel_reason, corrected_at, correction_action')
    .order('created_at', { ascending: false })
    .limit(50);
  const term = query.trim().slice(0, 40).replace(/[%_,(){}]/g, '');
  if (term) {
    const found = (unwrap(await supabase.from('users').select('id').ilike('username', `%${term}%`).limit(20)) ?? []) as { id: string }[];
    if (found.length === 0) return [];
    const ids = found.map((user) => user.id).join(',');
    request = request.or(`team_a.ov.{${ids}},team_b.ov.{${ids}}`);
  }
  const matches = (unwrap(await request) ?? []) as { id: string; team_a: string[]; team_b: string[] }[];
  if (matches.length === 0) return [];

  const playerIds = [...new Set(matches.flatMap((match) => [...match.team_a, ...match.team_b]))];
  const [users, requests] = await Promise.all([
    supabase.from('users').select('id, username').in('id', playerIds),
    supabase.from('cod_arbitration_requests').select('match_id').eq('status', 'open').in('match_id', matches.map((match) => match.id)),
  ]);
  if (users.error) throw fromDbError(users.error);
  if (requests.error) throw fromDbError(requests.error);
  const names = Object.fromEntries(((users.data ?? []) as { id: string; username: string }[]).map((user) => [user.id, user.username]));
  const open = new Map<string, number>();
  for (const row of (requests.data ?? []) as { match_id: string }[]) open.set(row.match_id, (open.get(row.match_id) ?? 0) + 1);
  return matches.map((match) => ({ ...match, names, openRequests: open.get(match.id) ?? 0 }));
}

/** Historique des corrections de matchs terminés (admin) : qui, quand, pourquoi, points avant et après. */
export async function listCorrections() {
  const rows = (unwrap(
    await supabase
      .from('cod_match_corrections')
      .select('id, match_id, staff_id, action, previous_winner, new_winner, reason, points_before, points_after, created_at')
      .order('created_at', { ascending: false })
      .limit(100),
  ) ?? []) as { match_id: string; staff_id: string | null; points_before: Record<string, number> | null }[];
  if (rows.length === 0) return [];
  const matchIds = [...new Set(rows.map((row) => row.match_id))];
  const matches = (unwrap(await supabase.from('cod_matches').select('id, map, format, team_size, team_a, team_b').in('id', matchIds)) ?? []) as {
    id: string;
    team_a: string[];
    team_b: string[];
  }[];
  const byMatch = new Map(matches.map((match) => [match.id, match]));
  const ids = new Set<string>();
  for (const row of rows) if (row.staff_id) ids.add(row.staff_id);
  for (const match of matches) for (const id of [...match.team_a, ...match.team_b]) ids.add(id);
  const users = (unwrap(await supabase.from('users').select('id, username').in('id', [...ids])) ?? []) as { id: string; username: string }[];
  const names = Object.fromEntries(users.map((user) => [user.id, user.username]));
  return rows.map((row) => ({ ...row, match: byMatch.get(row.match_id) ?? null, names }));
}
