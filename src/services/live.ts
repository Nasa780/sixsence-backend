import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { highlights } from './highlights.js';
import { CHECKIN_MINUTES, REVEAL_MINUTES, anubisCapacity } from './tournamentPolicy.js';

/**
 * Panneau « En direct » de l'accueil (GET /live, public) : en un seul appel, l'activité du moment (Classé, Division,
 * coupe ou tournoi, événement GTA 6, connectés) et les dernières actions du fil d'activité. Chaque bloc vaut null
 * quand il n'y a rien à montrer (jamais de compteur à zéro côté site). En mémoire 15 s ; les connectés et la file
 * (en mémoire du serveur) sont fournis par l'appelant.
 */

const TTL = 15_000;
const OPEN = ['in_progress', 'awaiting_confirmation', 'forfeit_claimed', 'disputed'];
const DAY = 86_400_000;
let cache: { at: number; data: Awaited<ReturnType<typeof compute>> } | null = null;

type Team = { id: string; name: string; tag: string; color: string; logo_url: string | null };
const card = (t: Team | undefined) => (t ? { id: t.id, name: t.name, tag: t.tag, color: t.color, logoUrl: t.logo_url } : null);

async function compute() {
  const now = Date.now();
  const [codLive, teamLive, teamQueue, activeTeams, cups, gta] = await Promise.all([
    supabase.from('cod_matches').select('id, format, team_size', { count: 'exact' }).in('status', ['ready_check', 'in_progress', 'awaiting_confirmation']).order('created_at', { ascending: false }).limit(1),
    supabase.from('team_matches').select('id, team_a, team_b, maps, scores, best_of, tournament_id', { count: 'exact' }).in('status', OPEN).order('created_at', { ascending: false }).limit(1),
    supabase.from('team_queue').select('team_id', { count: 'exact', head: true }),
    supabase.from('teams').select('id', { count: 'exact', head: true }).is('disbanded_at', null).is('cup_tournament', null),
    supabase.from('tournaments').select('id, kind, name, size, team_size, status, starts_at').in('status', ['scheduled', 'running']).order('starts_at').limit(3),
    supabase
      .from('gta_events')
      .select('id, title, starts_at, ends_at')
      .eq('status', 'published')
      .gte('starts_at', new Date(now - 6 * 3_600_000).toISOString())
      .lte('starts_at', new Date(now + 7 * DAY).toISOString())
      .order('starts_at')
      .limit(3),
  ]);

  // Division : affiche du match le plus récent (map en cours).
  const featured = (teamLive.data ?? [])[0] as { id: string; team_a: string; team_b: string; maps: { map: string }[] | null; scores: [number, number][] | null; best_of: number; tournament_id: string | null } | undefined;
  let division = null;
  if (featured || (teamQueue.count ?? 0) > 0) {
    const ids = featured ? [featured.team_a, featured.team_b] : [];
    const teams = ids.length ? (((await supabase.from('teams').select('id, name, tag, color, logo_url').in('id', ids)).data ?? []) as Team[]) : [];
    const played = featured?.scores?.length ?? 0;
    division = {
      inProgress: teamLive.count ?? 0,
      searching: teamQueue.count ?? 0,
      match: featured
        ? {
            id: featured.id,
            teamA: card(teams.find((t) => t.id === featured.team_a)),
            teamB: card(teams.find((t) => t.id === featured.team_b)),
            map: featured.maps?.[Math.min(played, (featured.maps?.length ?? 1) - 1)]?.map ?? null,
            mapNumber: played + 1,
            bestOf: featured.best_of,
            tournament: Boolean(featured.tournament_id),
          }
        : null,
    };
  }

  // Coupe ou tournoi : le plus proche (en cours d'abord), avec sa phase.
  const rows = (cups.data ?? []) as { id: string; kind: string; name: string; size: number; team_size: number | null; status: string; starts_at: string }[];
  const cupRow = rows.find((c) => c.status === 'running') ?? rows[0];
  let cup = null;
  if (cupRow) {
    const start = new Date(cupRow.starts_at).getTime();
    const anubis = cupRow.kind === 'anubis';
    const { count } = await supabase.from(anubis ? 'cup_players' : 'tournament_teams').select('tournament_id', { count: 'exact', head: true }).eq('tournament_id', cupRow.id);
    const phase =
      cupRow.status === 'running'
        ? now < start
          ? 'drawn'
          : 'running'
        : now >= start - CHECKIN_MINUTES * 60_000
          ? 'checkin'
          : 'registration';
    cup = {
      id: cupRow.id,
      kind: cupRow.kind,
      name: cupRow.name,
      phase,
      startsAt: cupRow.starts_at,
      drawAt: new Date(start - REVEAL_MINUTES * 60_000).toISOString(),
      registered: count ?? 0,
      capacity: anubis ? anubisCapacity(cupRow.size, cupRow.team_size ?? config.teams.rosterSize) : cupRow.size,
    };
  }

  // GTA 6 : événement en cours, sinon le prochain de la semaine.
  const events = (gta.data ?? []) as { id: string; title: string; starts_at: string; ends_at: string | null }[];
  const liveEvent = events.find((e) => new Date(e.starts_at).getTime() <= now && now < (e.ends_at ? new Date(e.ends_at).getTime() : new Date(e.starts_at).getTime() + 3 * 3_600_000));
  const event = liveEvent ?? events.find((e) => new Date(e.starts_at).getTime() > now);
  let gtaEvent = null;
  if (event) {
    const { count } = await supabase.from('gta_registrations').select('event_id', { count: 'exact', head: true }).eq('event_id', event.id);
    gtaEvent = { id: event.id, title: event.title, startsAt: event.starts_at, live: event === liveEvent, registered: count ?? 0 };
  }

  const firstCod = (codLive.data ?? [])[0] as { format: string | null; team_size: number } | undefined;
  const recent = ((await highlights()) as { feed?: { id: string; type: string; at: string; href: string; text: string }[] }).feed ?? [];
  const feed = recent.slice(0, 6).map((e) => ({ id: e.id, type: e.type, at: e.at, href: e.href, text: e.text }));
  return {
    classe: { inProgress: codLive.count ?? 0, format: firstCod ? (firstCod.format ?? `${firstCod.team_size}v${firstCod.team_size}`) : null },
    division,
    activeTeams: activeTeams.count ?? 0,
    cup,
    gta: gtaEvent,
    feed,
  };
}

export async function liveActivity(memory: { online: number; inQueue: number }) {
  if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), data: await compute() };
  const { classe, ...rest } = cache.data;
  const active = classe.inProgress > 0 || memory.inQueue > 0;
  return {
    online: memory.online,
    classe: active ? { ...classe, inQueue: memory.inQueue } : null,
    ...rest,
  };
}
