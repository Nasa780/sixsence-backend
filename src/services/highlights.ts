import { supabase } from '../supabase.js';
import { anubisCapacity } from './tournamentPolicy.js';

/**
 * Temps forts publics (GET /highlights) et Hall of Fame (GET /hall-of-fame), calculés depuis les tables
 * existantes, gardés en mémoire quelques minutes :
 *   - joueur de la semaine : le plus de points gagnés en classé sur 7 jours (3 matchs au moins) ;
 *   - match de la semaine : le « choc » des 7 derniers jours, le match classé terminé dont les joueurs
 *     ont le plus de points cumulés ;
 *   - fil d'activité : derniers matchs classés et de Division, équipes créées, coupes gagnées, arrivées ;
 *   - « En ce moment » (accueil) : podiums du Classé et de la Division, prochaine coupe, records du moment
 *     (le plus de matchs aujourd'hui, la plus longue série en cours, l'équipe la plus active de la semaine) ;
 *   - Hall of Fame : champions de saison (joueurs et équipes), vainqueurs de coupes, MVP du mois, records.
 */

const WEEK = 7 * 86_400_000;
const TTL = 3 * 60_000;
let highlightsCache: { at: number; data: unknown } | null = null;
let fameCache: { at: number; data: unknown } | null = null;

type User = { id: string; username: string; avatar_url: string | null };
type CodMatch = {
  id: string;
  team_a: string[];
  team_b: string[];
  winner: 'A' | 'B' | null;
  map: string;
  format: string | null;
  team_size: number;
  points_changes: Record<string, number> | null;
  completed_at: string;
};

async function usersById(ids: string[]) {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return new Map<string, User>();
  const { data } = await supabase.from('users').select('id, username, avatar_url').in('id', unique);
  return new Map(((data ?? []) as User[]).map((u) => [u.id, u]));
}

const person = (users: Map<string, User>, id: string) => {
  const u = users.get(id);
  return { id, username: u?.username ?? 'Joueur', avatarUrl: u?.avatar_url ?? null };
};

export async function highlights() {
  if (highlightsCache && Date.now() - highlightsCache.at < TTL) return highlightsCache.data;
  const since = new Date(Date.now() - WEEK).toISOString();
  const [week, recentCod, recentTeam, newTeams, cups, joined] = await Promise.all([
    supabase.from('cod_matches').select('id, team_a, team_b, winner, map, format, team_size, points_changes, completed_at').eq('status', 'completed').gte('completed_at', since).limit(2000),
    supabase.from('cod_matches').select('id, team_a, team_b, winner, map, format, team_size, points_changes, completed_at').eq('status', 'completed').order('completed_at', { ascending: false }).limit(12),
    supabase.from('team_matches').select('id, team_a, team_b, winner, scores, tournament_id, completed_at').eq('status', 'completed').order('completed_at', { ascending: false }).limit(10),
    supabase.from('teams').select('id, name, tag, color, logo_url, created_at').is('cup_tournament', null).order('created_at', { ascending: false }).limit(6),
    supabase.from('tournaments').select('id, kind, name, winner_team, completed_at').eq('status', 'completed').order('completed_at', { ascending: false }).limit(6),
    supabase.from('users').select('id, username, avatar_url, created_at').order('created_at', { ascending: false }).limit(6),
  ]);

  // Joueur de la semaine.
  const weekMatches = (week.data ?? []) as CodMatch[];
  const tally = new Map<string, { net: number; wins: number; losses: number }>();
  for (const m of weekMatches) {
    for (const id of [...m.team_a, ...m.team_b]) {
      const row = tally.get(id) ?? { net: 0, wins: 0, losses: 0 };
      row.net += m.points_changes?.[id] ?? 0;
      const won = (m.winner === 'A' && m.team_a.includes(id)) || (m.winner === 'B' && m.team_b.includes(id));
      if (won) row.wins += 1;
      else row.losses += 1;
      tally.set(id, row);
    }
  }
  const best = [...tally.entries()].filter(([, r]) => r.wins + r.losses >= 3).sort((a, b) => b[1].net - a[1].net || b[1].wins - a[1].wins)[0];

  // Match de la semaine : le plus de points cumulés (niveau actuel des joueurs).
  const ids = [...new Set(weekMatches.flatMap((m) => [...m.team_a, ...m.team_b]))];
  const { data: profiles } = ids.length ? await supabase.from('cod_profiles').select('user_id, points').in('user_id', ids) : { data: [] };
  const level = new Map(((profiles ?? []) as { user_id: string; points: number }[]).map((p) => [p.user_id, p.points]));
  const clash = weekMatches
    .map((m) => ({ m, total: [...m.team_a, ...m.team_b].reduce((sum, id) => sum + (level.get(id) ?? 0), 0) }))
    .sort((a, b) => b.total - a.total)[0];

  // Fil d'activité.
  const codRows = (recentCod.data ?? []) as CodMatch[];
  const teamRows = (recentTeam.data ?? []) as { id: string; team_a: string; team_b: string; winner: 'A' | 'B' | null; scores: [number, number][]; tournament_id: string | null; completed_at: string }[];
  const cupRows = (cups.data ?? []) as { id: string; kind: string; name: string; winner_team: string | null; completed_at: string }[];
  const teamIds = [...new Set([...teamRows.flatMap((r) => [r.team_a, r.team_b]), ...cupRows.map((c) => c.winner_team).filter(Boolean) as string[]])];
  const { data: teamData } = teamIds.length ? await supabase.from('teams').select('id, name, tag, color, logo_url').in('id', teamIds) : { data: [] };
  const teams = new Map(((teamData ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null }[]).map((t) => [t.id, t]));
  const users = await usersById([...codRows.flatMap((m) => [...m.team_a, ...m.team_b]), ...(best ? [best[0]] : []), ...(clash ? [...clash.m.team_a, ...clash.m.team_b] : [])]);
  const teamCard = (id: string | null) => {
    const t = id ? teams.get(id) : undefined;
    return t ? { id: t.id, name: t.name, tag: t.tag, color: t.color, logoUrl: t.logo_url } : null;
  };

  const feed = [
    ...codRows.map((m) => {
      const winners = m.winner === 'A' ? m.team_a : m.team_b;
      return {
        id: `c-${m.id}`,
        type: 'classe',
        at: m.completed_at,
        href: `/cod/match/${m.id}`,
        text: `${winners.map((id) => person(users, id).username).join(', ')} ${winners.length > 1 ? 'gagnent' : 'gagne'} en ${m.format ?? `${m.team_size}v${m.team_size}`} sur ${m.map}`,
        points: winners[0] ? (m.points_changes?.[winners[0]] ?? null) : null,
        avatar: winners[0] ? person(users, winners[0]).avatarUrl : null,
      };
    }),
    ...teamRows.map((r) => {
      const win = teamCard(r.winner === 'A' ? r.team_a : r.team_b);
      const lose = teamCard(r.winner === 'A' ? r.team_b : r.team_a);
      const mapsWin = r.scores.filter(([a, b]) => (r.winner === 'A' ? a > b : b > a)).length;
      return {
        id: `t-${r.id}`,
        type: r.tournament_id ? 'tournoi' : 'division',
        at: r.completed_at,
        href: `/cod/equipes/match/${r.id}`,
        text: `[${win?.tag ?? '?'}] bat [${lose?.tag ?? '?'}] ${mapsWin}-${r.scores.length - mapsWin}`,
        team: win,
      };
    }),
    ...cupRows
      .filter((c) => c.winner_team)
      .map((c) => ({ id: `w-${c.id}`, type: 'coupe', at: c.completed_at, href: c.kind === 'anubis' ? '/cod/tournoi?coupe=anubis' : c.kind === 'horus' ? '/cod/tournoi' : '/cod/tournoi?coupe=saison', text: `${teamCard(c.winner_team)?.name ?? 'Une équipe'} remporte ${c.name}`, team: teamCard(c.winner_team) })),
    ...((newTeams.data ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null; created_at: string }[]).map((t) => ({
      id: `e-${t.id}`,
      type: 'equipe',
      at: t.created_at,
      href: `/cod/equipes/${t.id}`,
      text: `Nouvelle équipe : [${t.tag}] ${t.name}`,
      team: { id: t.id, name: t.name, tag: t.tag, color: t.color, logoUrl: t.logo_url },
    })),
    ...((joined.data ?? []) as (User & { created_at: string })[]).map((u) => ({ id: `u-${u.id}`, type: 'arrivee', at: u.created_at, href: `/cod/profile/${u.id}`, text: `${u.username} rejoint SixSence`, avatar: u.avatar_url })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);

  const now = await rightNow(weekMatches, users);

  const data = {
    ...now,
    playerOfWeek: best ? { ...person(users, best[0]), points: level.get(best[0]) ?? null, ...best[1] } : null,
    matchOfWeek: clash
      ? {
          id: clash.m.id,
          map: clash.m.map,
          format: clash.m.format ?? `${clash.m.team_size}v${clash.m.team_size}`,
          completedAt: clash.m.completed_at,
          total: clash.total,
          winner: clash.m.winner,
          teamA: clash.m.team_a.map((id) => ({ ...person(users, id), points: level.get(id) ?? 0 })),
          teamB: clash.m.team_b.map((id) => ({ ...person(users, id), points: level.get(id) ?? 0 })),
        }
      : null,
    feed,
  };
  highlightsCache = { at: Date.now(), data };
  return data;
}

/** Jour de Paris (AAAA-MM-JJ) d'une date. */
const parisDay = (iso: string | number) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

/** « En ce moment » sur l'accueil : podiums, prochaine coupe et records du moment (null quand il n'y a rien à montrer). */
async function rightNow(weekMatches: CodMatch[], known: Map<string, User>) {
  const since = new Date(Date.now() - WEEK).toISOString();
  const [classe, division, streak, weekTeam, cup] = await Promise.all([
    supabase.from('cod_leaderboard').select('user_id, username, avatar_url, points').or('wins.gt.0,losses.gt.0').order('points', { ascending: false }).limit(3),
    supabase.from('teams').select('id, name, tag, color, logo_url, points, wins, losses').is('disbanded_at', null).is('cup_tournament', null).order('points', { ascending: false }).limit(20),
    supabase.from('cod_profiles').select('user_id, win_streak').gte('win_streak', 3).order('win_streak', { ascending: false }).limit(1),
    supabase.from('team_matches').select('team_a, team_b, roster_a, roster_b, completed_at, tournament_id').eq('status', 'completed').gte('completed_at', since).limit(1000),
    supabase.from('tournaments').select('id, kind, name, size, team_size, best_of, starts_at').eq('status', 'scheduled').gt('starts_at', new Date().toISOString()).order('starts_at').limit(1),
  ]);
  const teamWeek = (weekTeam.data ?? []) as { team_a: string; team_b: string; roster_a: string[]; roster_b: string[]; completed_at: string; tournament_id: string | null }[];

  // Le plus de matchs aujourd'hui (Classé + équipe), 2 au moins.
  const today = parisDay(Date.now());
  const perPlayer = new Map<string, number>();
  for (const m of weekMatches) if (parisDay(m.completed_at) === today) for (const id of [...m.team_a, ...m.team_b]) perPlayer.set(id, (perPlayer.get(id) ?? 0) + 1);
  for (const m of teamWeek) if (parisDay(m.completed_at) === today) for (const id of [...m.roster_a, ...m.roster_b]) perPlayer.set(id, (perPlayer.get(id) ?? 0) + 1);
  const busiest = [...perPlayer.entries()].sort((a, b) => b[1] - a[1])[0];

  // Équipe la plus active de la semaine (hors équipes temporaires de coupe), 2 matchs au moins.
  const perTeam = new Map<string, number>();
  for (const m of teamWeek) for (const id of [m.team_a, m.team_b]) perTeam.set(id, (perTeam.get(id) ?? 0) + 1);
  const teams = (division.data ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null; points: number; wins: number; losses: number }[];
  const active = [...perTeam.entries()].filter(([id]) => teams.some((t) => t.id === id)).sort((a, b) => b[1] - a[1])[0];

  const streakRow = ((streak.data ?? []) as { user_id: string; win_streak: number }[])[0];
  const missing = [busiest?.[0], streakRow?.user_id].filter((id): id is string => Boolean(id) && !known.has(id!));
  const users = new Map([...known, ...(await usersById(missing))]);
  const teamOf = (id: string) => {
    const t = teams.find((row) => row.id === id)!;
    return { id: t.id, name: t.name, tag: t.tag, color: t.color, logoUrl: t.logo_url };
  };

  // Prochaine coupe ou tournoi : inscrits (équipes, ou joueurs pour la Coupe Anubis).
  const next = ((cup.data ?? []) as { id: string; kind: string; name: string; size: number; team_size: number | null; best_of: number; starts_at: string }[])[0];
  let nextCup = null;
  if (next) {
    const anubis = next.kind === 'anubis';
    const { count } = await supabase.from(anubis ? 'cup_players' : 'tournament_teams').select('tournament_id', { count: 'exact', head: true }).eq('tournament_id', next.id);
    nextCup = {
      id: next.id,
      kind: next.kind,
      name: next.name,
      startsAt: next.starts_at,
      bestOf: next.best_of,
      registered: count ?? 0,
      capacity: anubis ? anubisCapacity(next.size, next.team_size ?? 4) : next.size,
      unit: anubis ? 'joueurs' : 'équipes',
    };
  }

  const podiumClasse = ((classe.data ?? []) as { user_id: string; username: string; avatar_url: string | null; points: number }[]).map((p) => ({ id: p.user_id, username: p.username, avatarUrl: p.avatar_url, points: p.points }));
  const podiumDivision = teams.filter((t) => t.wins + t.losses > 0).slice(0, 3).map((t) => ({ ...teamOf(t.id), points: t.points }));

  return {
    podiums: { classe: podiumClasse, division: podiumDivision },
    nextCup,
    records: {
      mostMatchesToday: busiest && busiest[1] >= 2 ? { ...person(users, busiest[0]), value: busiest[1] } : null,
      longestStreak: streakRow ? { ...person(users, streakRow.user_id), value: streakRow.win_streak } : null,
      mostActiveTeam: active && active[1] >= 2 ? { team: teamOf(active[0]), value: active[1] } : null,
    },
  };
}

export async function hallOfFame() {
  if (fameCache && Date.now() - fameCache.at < TTL) return fameCache.data;
  const [seasons, players, teamResults, cups, medals, mvps, records] = await Promise.all([
    supabase.from('seasons').select('id, name, starts_at, ends_at, is_active').order('id', { ascending: false }),
    supabase.from('season_results').select('season_id, user_id, position, username, points, wins, losses').lte('position', 3),
    supabase.from('team_season_results').select('season_id, team_id, position, name, tag, points, wins, losses').lte('position', 3),
    supabase.from('tournaments').select('id, kind, name, winner_team, finalist_team, third_team, completed_at, season_id').eq('status', 'completed').order('completed_at', { ascending: false }).limit(60),
    supabase.from('cup_medals').select('tournament_id, user_id, place, team_name').eq('place', 'or'),
    supabase.from('cod_monthly_mvp').select('month, user_id, votes').order('month', { ascending: false }).limit(24),
    supabase.from('cod_profiles').select('user_id, best_streak, peak_points, xp, wins').limit(10000),
  ]);
  const recordRows = (records.data ?? []) as { user_id: string; best_streak: number; peak_points: number; xp: number; wins: number }[];
  const top = (key: 'best_streak' | 'peak_points' | 'xp' | 'wins') => [...recordRows].sort((a, b) => b[key] - a[key])[0];
  const recordTop = { streak: top('best_streak'), peak: top('peak_points'), xp: top('xp'), wins: top('wins') };
  const medalRows = (medals.data ?? []) as { tournament_id: string; user_id: string; team_name: string | null }[];
  const mvpRows = (mvps.data ?? []) as { month: string; user_id: string; votes: number }[];
  const users = await usersById([...medalRows.map((m) => m.user_id), ...mvpRows.map((m) => m.user_id), ...Object.values(recordTop).map((r) => r?.user_id ?? '')]);
  const cupRows = (cups.data ?? []) as { id: string; kind: string; name: string; winner_team: string | null; finalist_team: string | null; completed_at: string }[];
  const teamIds = [...new Set(cupRows.flatMap((c) => [c.winner_team, c.finalist_team]).filter(Boolean) as string[])];
  const { data: teamData } = teamIds.length ? await supabase.from('teams').select('id, name, tag, color, logo_url, cup_tournament').in('id', teamIds) : { data: [] };
  const teams = new Map(((teamData ?? []) as { id: string; name: string; tag: string; color: string; logo_url: string | null; cup_tournament: string | null }[]).map((t) => [t.id, t]));
  const teamCard = (id: string | null) => {
    const t = id ? teams.get(id) : undefined;
    return t ? { id: t.id, name: t.name, tag: t.tag, color: t.color, logoUrl: t.logo_url, cup: Boolean(t.cup_tournament) } : null;
  };
  const record = (row: (typeof recordRows)[number] | undefined, value: number | undefined) => (row && value ? { ...person(users, row.user_id), value } : null);

  const data = {
    seasons: ((seasons.data ?? []) as { id: number; name: string; starts_at: string; ends_at: string | null; is_active: boolean }[])
      .filter((s) => !s.is_active)
      .map((s) => ({
        id: s.id,
        name: s.name,
        endedAt: s.ends_at,
        players: ((players.data ?? []) as { season_id: number; user_id: string; position: number; username: string; points: number; wins: number; losses: number }[])
          .filter((p) => p.season_id === s.id)
          .sort((a, b) => a.position - b.position),
        teams: ((teamResults.data ?? []) as { season_id: number; team_id: string; position: number; name: string; tag: string; points: number }[])
          .filter((t) => t.season_id === s.id)
          .sort((a, b) => a.position - b.position),
      })),
    cups: cupRows
      .filter((c) => c.winner_team)
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        completedAt: c.completed_at,
        winner: teamCard(c.winner_team),
        finalist: teamCard(c.finalist_team),
        players: c.kind === 'anubis' ? medalRows.filter((m) => m.tournament_id === c.id).map((m) => person(users, m.user_id)) : [],
      })),
    mvps: mvpRows.map((m) => ({ month: m.month, votes: m.votes, ...person(users, m.user_id) })),
    records: {
      streak: record(recordTop.streak, recordTop.streak?.best_streak),
      peak: record(recordTop.peak, recordTop.peak?.peak_points),
      xp: record(recordTop.xp, recordTop.xp?.xp),
      wins: record(recordTop.wins, recordTop.wins?.wins),
    },
  };
  fameCache = { at: Date.now(), data };
  return data;
}
