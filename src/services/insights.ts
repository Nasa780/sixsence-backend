import { unwrap } from '../errors.js';
import { supabase } from '../supabase.js';

/**
 * Analyse d'un joueur (profil, section « Analyse ») : place sur le site pour chaque chiffre, ratio sur 30 jours,
 * adversaires et coéquipiers les plus fréquents en Classé, face à face avec le visiteur, activité par jour,
 * équipes jouées (actuelle et anciennes). Lecture publique, sauf le face à face (visiteur connecté).
 */

const DAY = 86_400_000;
const MIN_RATE_MATCHES = 10;

interface CodRow {
  team_a: string[];
  team_b: string[];
  winner: 'A' | 'B' | null;
  completed_at: string;
}

interface TeamMatchRow {
  team_a: string;
  team_b: string;
  roster_a: string[];
  roster_b: string[];
  winner: 'A' | 'B' | null;
  completed_at: string;
  tournament_id: string | null;
}

/** Profils de tous les joueurs (chiffres du classement), gardés 60 s : les places se calculent en mémoire. */
let profilesCache: { at: number; rows: { user_id: string; wins: number; losses: number; best_streak: number; xp: number }[] } | null = null;
async function allProfiles() {
  if (profilesCache && Date.now() - profilesCache.at < 60_000) return profilesCache.rows;
  const rows = (unwrap(await supabase.from('cod_profiles').select('user_id, wins, losses, best_streak, xp')) ?? []) as { user_id: string; wins: number; losses: number; best_streak: number; xp: number }[];
  profilesCache = { at: Date.now(), rows };
  return rows;
}

/** Place (1 = meilleur) d'une valeur parmi d'autres, ou null si le joueur n'est pas classé sur ce chiffre. */
const placeOf = (value: number | null, values: number[]) => (value === null ? null : values.filter((v) => v > value).length + 1);

export async function playerInsights(userId: string, viewerId: string | null) {
  const since = new Date(Date.now() - 365 * DAY).toISOString();
  const [profiles, codRows, teamRows, membership] = await Promise.all([
    allProfiles(),
    supabase
      .from('cod_matches')
      .select('team_a, team_b, winner, completed_at')
      .eq('status', 'completed')
      .gte('completed_at', since)
      .or(`team_a.cs.{${userId}},team_b.cs.{${userId}}`)
      .order('completed_at', { ascending: false })
      .limit(1000),
    supabase
      .from('team_matches')
      .select('team_a, team_b, roster_a, roster_b, winner, completed_at, tournament_id')
      .eq('status', 'completed')
      .gte('completed_at', since)
      .or(`roster_a.cs.{${userId}},roster_b.cs.{${userId}}`)
      .order('completed_at', { ascending: false })
      .limit(500),
    supabase.from('team_members').select('team_id, role, joined_at').eq('user_id', userId).maybeSingle(),
  ]);
  const cod = (unwrap(codRows) ?? []) as CodRow[];
  const teamMatches = (unwrap(teamRows) ?? []) as TeamMatchRow[];

  // --- Places sur le site ---------------------------------------------------------------
  const me = profiles.find((p) => p.user_id === userId);
  const played = (p: { wins: number; losses: number }) => p.wins + p.losses;
  const rateOf = (p: { wins: number; losses: number }) => (played(p) >= MIN_RATE_MATCHES ? Math.round((p.wins / played(p)) * 100) : null);
  const active = profiles.filter((p) => played(p) > 0);
  const ranks = me
    ? {
        played: { value: played(me), place: played(me) > 0 ? placeOf(played(me), active.map(played)) : null },
        wins: { value: me.wins, place: me.wins > 0 ? placeOf(me.wins, active.map((p) => p.wins)) : null },
        rate: { value: rateOf(me), place: placeOf(rateOf(me), active.map(rateOf).filter((v): v is number => v !== null)), minMatches: MIN_RATE_MATCHES },
        bestStreak: { value: me.best_streak, place: me.best_streak > 0 ? placeOf(me.best_streak, profiles.map((p) => p.best_streak)) : null },
        xp: { value: me.xp, place: me.xp > 0 ? placeOf(me.xp, profiles.map((p) => p.xp)) : null },
        players: active.length,
      }
    : null;

  // --- Classé : résultat de chaque match pour ce joueur -----------------------------------
  const codResults = cod
    .filter((m) => m.winner)
    .map((m) => {
      const mine = m.team_a.includes(userId) ? 'A' : 'B';
      return { won: m.winner === mine, at: m.completed_at, mates: (mine === 'A' ? m.team_a : m.team_b).filter((id) => id !== userId), rivals: mine === 'A' ? m.team_b : m.team_a };
    });
  const recent = codResults.filter((r) => Date.now() - new Date(r.at).getTime() < 30 * DAY);
  const ratio = (list: { won: boolean }[]) => (list.length ? Math.round((list.filter((r) => r.won).length / list.length) * 100) : null);

  // Adversaires et coéquipiers les plus fréquents (3 matchs ensemble au moins).
  const tally = (pick: (r: (typeof codResults)[number]) => string[]) => {
    const counts = new Map<string, { played: number; won: number }>();
    for (const r of codResults) {
      for (const id of pick(r)) {
        const c = counts.get(id) ?? { played: 0, won: 0 };
        c.played += 1;
        if (r.won) c.won += 1;
        counts.set(id, c);
      }
    }
    return [...counts.entries()]
      .filter(([, c]) => c.played >= 3)
      .sort((a, b) => b[1].played - a[1].played || b[1].won - a[1].won)
      .slice(0, 5)
      .map(([id, c]) => ({ id, played: c.played, won: c.won, lost: c.played - c.won }));
  };
  const opponents = tally((r) => r.rivals);
  const teammates = tally((r) => r.mates);

  // --- Face à face avec le visiteur (Classé et matchs d'équipe) ------------------------------
  let headToHead = null;
  if (viewerId && viewerId !== userId) {
    const against = codResults.filter((r) => r.rivals.includes(viewerId));
    const together = codResults.filter((r) => r.mates.includes(viewerId));
    const teamAgainst = teamMatches.filter((m) => {
      const mine = m.roster_a.includes(userId) ? 'A' : 'B';
      return (mine === 'A' ? m.roster_b : m.roster_a).includes(viewerId);
    });
    const teamWon = teamAgainst.filter((m) => m.winner === (m.roster_a.includes(userId) ? 'A' : 'B')).length;
    headToHead = {
      // Du point de vue du visiteur : ses victoires contre ce joueur.
      viewerWins: against.filter((r) => !r.won).length + (teamAgainst.length - teamWon),
      viewerLosses: against.filter((r) => r.won).length + teamWon,
      together: together.length,
      togetherWins: together.filter((r) => r.won).length,
      last: [...against.map((r) => r.at), ...teamAgainst.map((m) => m.completed_at)].sort().at(-1) ?? null,
    };
  }

  // --- Activité : matchs par jour sur 90 jours (Classé + équipe) -----------------------------
  const activity: Record<string, number> = {};
  for (const at of [...codResults.map((r) => r.at), ...teamMatches.map((m) => m.completed_at)]) {
    if (Date.now() - new Date(at).getTime() > 90 * DAY) continue;
    const day = new Date(at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    activity[day] = (activity[day] ?? 0) + 1;
  }

  // --- Équipes jouées : actuelle (effectif) et anciennes (matchs d'équipe hors coupes Anubis) ---
  const byTeam = new Map<string, { first: string; last: string; played: number }>();
  for (const m of teamMatches) {
    const teamId = m.roster_a.includes(userId) ? m.team_a : m.team_b;
    const t = byTeam.get(teamId) ?? { first: m.completed_at, last: m.completed_at, played: 0 };
    t.played += 1;
    if (m.completed_at < t.first) t.first = m.completed_at;
    if (m.completed_at > t.last) t.last = m.completed_at;
    byTeam.set(teamId, t);
  }
  const current = unwrap(membership) as { team_id: string; role: string; joined_at: string } | null;
  const teamIds = [...new Set([...(current ? [current.team_id] : []), ...byTeam.keys()])];
  const teamCards = teamIds.length
    ? ((unwrap(await supabase.from('teams').select('id, name, tag, color, logo_url, disbanded_at, cup_tournament').in('id', teamIds)) ?? []) as {
        id: string;
        name: string;
        tag: string;
        color: string;
        logo_url: string | null;
        disbanded_at: string | null;
        cup_tournament: string | null;
      }[])
    : [];
  const teams = teamCards
    .filter((t) => !t.cup_tournament)
    .map((t) => ({
      id: t.id,
      name: t.name,
      tag: t.tag,
      color: t.color,
      logoUrl: t.logo_url,
      disbanded: Boolean(t.disbanded_at),
      current: current?.team_id === t.id,
      role: current?.team_id === t.id ? current.role : null,
      since: current?.team_id === t.id ? current.joined_at : (byTeam.get(t.id)?.first ?? null),
      until: current?.team_id === t.id ? null : (byTeam.get(t.id)?.last ?? null),
      played: byTeam.get(t.id)?.played ?? 0,
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || (b.until ?? '').localeCompare(a.until ?? ''));

  // Noms des joueurs cités.
  const ids = [...new Set([...opponents, ...teammates].map((p) => p.id))];
  const users = ids.length ? ((unwrap(await supabase.from('users').select('id, username, avatar_url').in('id', ids)) ?? []) as { id: string; username: string; avatar_url: string | null }[]) : [];
  const named = <T extends { id: string }>(list: T[]) =>
    list.map((p) => ({ ...p, username: users.find((u) => u.id === p.id)?.username ?? 'Joueur', avatarUrl: users.find((u) => u.id === p.id)?.avatar_url ?? null }));

  return {
    ranks,
    ratio: { last30: ratio(recent), last30Played: recent.length, overall: ratio(codResults), overallPlayed: codResults.length },
    opponents: named(opponents),
    teammates: named(teammates),
    headToHead,
    activity,
    teams,
  };
}
