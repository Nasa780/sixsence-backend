import { config } from '../config.js';
import { HttpError, fromDbError, unwrap } from '../errors.js';
import { MODERATORS, type Role } from '../roles.js';
import { supabase } from '../supabase.js';
import { CLIPS_MAX, CLIPS_PER_DAY, cleanTitle, parseClipUrl, type ClipProvider } from './clipPolicy.js';
import { notifyStaff } from './discord.js';
import { MAP_CATALOG } from './maps.js';

/**
 * Clips des joueurs (migration 0060) : ajout par lien (YouTube, Twitch, Medal, TikTok) avec un titre et, au besoin,
 * un match du joueur rattaché ; profil, page « Clips » (récents ou les plus votés de la semaine, par mode), clip de
 * la semaine (Renommée), fil d'activité. Votes « 🔥 » (un par joueur, pas sur ses propres clips), signalement au
 * salon staff, retrait par l'auteur ou l'équipe (admin, staff).
 */

const WEEK = 7 * 24 * 3600 * 1000;
const PAGE_SIZE = 24;

interface ClipRow {
  id: string;
  user_id: string;
  url: string;
  provider: ClipProvider;
  video_id: string;
  title: string;
  mode: 'classe' | 'division' | 'tournoi' | null;
  cod_match_id: string | null;
  team_match_id: string | null;
  context: string | null;
  created_at: string;
}

const COLUMNS = 'id, user_id, url, provider, video_id, title, mode, cod_match_id, team_match_id, context, created_at';
const mapName = (value: string | null) => MAP_CATALOG.find((map) => map.id === value)?.name ?? value ?? 'map inconnue';

/** Clips mis en forme : auteur, votes, vote du visiteur, lien du match rattaché. */
async function present(rows: ClipRow[], viewerId: string | null) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [{ data: users }, { data: votes }] = await Promise.all([
    supabase.from('users').select('id, username, avatar_url').in('id', [...new Set(rows.map((row) => row.user_id))]),
    supabase.from('clip_votes').select('clip_id, user_id').in('clip_id', ids),
  ]);
  const people = new Map(((users ?? []) as { id: string; username: string; avatar_url: string | null }[]).map((u) => [u.id, u]));
  const voteRows = (votes ?? []) as { clip_id: string; user_id: string }[];
  return rows.map((row) => {
    const author = people.get(row.user_id);
    return {
      id: row.id,
      url: row.url,
      provider: row.provider,
      videoId: row.video_id,
      title: row.title,
      mode: row.mode,
      context: row.context,
      matchHref: row.cod_match_id ? `/cod/match/${row.cod_match_id}` : row.team_match_id ? `/cod/equipes/match/${row.team_match_id}` : null,
      createdAt: row.created_at,
      author: { id: row.user_id, username: author?.username ?? 'Joueur', avatarUrl: author?.avatar_url ?? null },
      votes: voteRows.filter((vote) => vote.clip_id === row.id).length,
      voted: Boolean(viewerId && voteRows.some((vote) => vote.clip_id === row.id && vote.user_id === viewerId)),
    };
  });
}

/** Liste : ?sort=recent (défaut) | top (les plus votés des 7 derniers jours), ?mode=, ?user=, ?before= (pagination). */
export async function listClips(query: Record<string, unknown>, viewerId: string | null) {
  const sort = query.sort === 'top' ? 'top' : 'recent';
  const mode = ['classe', 'division', 'tournoi'].includes(String(query.mode)) ? String(query.mode) : null;
  const user = typeof query.user === 'string' && /^[0-9a-f-]{36}$/i.test(query.user) ? query.user : null;
  let request = supabase.from('clips').select(COLUMNS).is('removed_at', null);
  if (mode) request = request.eq('mode', mode);
  if (user) request = request.eq('user_id', user);
  if (sort === 'top') {
    request = request.gte('created_at', new Date(Date.now() - WEEK).toISOString()).order('created_at', { ascending: false }).limit(200);
  } else {
    if (typeof query.before === 'string' && !Number.isNaN(Date.parse(query.before))) request = request.lt('created_at', query.before);
    request = request.order('created_at', { ascending: false }).limit(user ? CLIPS_MAX : PAGE_SIZE);
  }
  const rows = unwrap(await request) as ClipRow[];
  const clips = await present(rows, viewerId);
  if (sort === 'top') clips.sort((a, b) => b.votes - a.votes || b.createdAt.localeCompare(a.createdAt)).splice(PAGE_SIZE);
  return { clips, more: sort === 'recent' && !user && rows.length === PAGE_SIZE };
}

/** Clip le plus voté des 7 derniers jours (une voix au moins), pour la Renommée et l'accueil. */
export async function clipOfWeek() {
  const { clips } = await listClips({ sort: 'top' }, null);
  return clips[0] && clips[0].votes > 0 ? clips[0] : null;
}

/** Matchs récents du joueur, à rattacher à un clip (10 classés et 10 d'équipe terminés). */
export async function recentMatchesFor(userId: string) {
  const [cod, team] = await Promise.all([
    supabase.from('cod_matches').select('id, map, format, team_size, team_a, winner, completed_at').eq('status', 'completed').or(`team_a.cs.{${userId}},team_b.cs.{${userId}}`).order('completed_at', { ascending: false }).limit(10),
    supabase.from('team_matches').select('id, maps, roster_a, winner, tournament_id, completed_at').eq('status', 'completed').or(`roster_a.cs.{${userId}},roster_b.cs.{${userId}}`).order('completed_at', { ascending: false }).limit(10),
  ]);
  const classe = ((cod.data ?? []) as { id: string; map: string | null; format: string | null; team_size: number; team_a: string[]; winner: 'A' | 'B' | null; completed_at: string }[]).map((m) => ({
    kind: 'classe' as const,
    id: m.id,
    at: m.completed_at,
    label: `Classé · ${m.format ?? `${m.team_size}v${m.team_size}`} · ${mapName(m.map)} · ${(m.winner === 'A') === m.team_a.includes(userId) ? 'victoire' : 'défaite'}`,
  }));
  const equipe = ((team.data ?? []) as { id: string; maps: string[] | null; roster_a: string[]; winner: 'A' | 'B' | null; tournament_id: string | null; completed_at: string }[]).map((m) => ({
    kind: 'equipe' as const,
    id: m.id,
    at: m.completed_at,
    label: `${m.tournament_id ? 'Tournoi' : 'Division'} · ${mapName(m.maps?.[0] ?? null)} · ${(m.winner === 'A') === m.roster_a.includes(userId) ? 'victoire' : 'défaite'}`,
    tournament: Boolean(m.tournament_id),
  }));
  return [...classe, ...equipe].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
}

/** Ajout : { url, title, match?: { kind: 'classe' | 'equipe', id } } (match joué par l'auteur). */
export async function createClip(userId: string, body: unknown) {
  const input = (body ?? {}) as { url?: unknown; title?: unknown; match?: { kind?: unknown; id?: unknown } | null };
  const parsed = typeof input.url === 'string' ? parseClipUrl(input.url) : null;
  if (!parsed) throw new HttpError(400, 'INVALID_CLIP_URL', 'Lien non reconnu : colle un lien YouTube, Twitch (clip), Medal ou TikTok.');
  const title = cleanTitle(input.title);
  if (!title) throw new HttpError(400, 'INVALID_CLIP_TITLE', 'Donne un titre à ton clip (80 caractères au plus).');

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ count: today }, { count: total }] = await Promise.all([
    supabase.from('clips').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since),
    supabase.from('clips').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('removed_at', null),
  ]);
  if ((today ?? 0) >= CLIPS_PER_DAY) throw new HttpError(429, 'CLIPS_DAILY_LIMIT', `${CLIPS_PER_DAY} clips par jour au plus : reviens demain.`);
  if ((total ?? 0) >= CLIPS_MAX) throw new HttpError(409, 'CLIPS_LIMIT', `Tu as déjà ${CLIPS_MAX} clips : retire-en un pour en ajouter.`);

  // Match rattaché : seulement un match terminé que l'auteur a joué ; libellé repris de la liste des matchs récents.
  let link: { mode: ClipRow['mode']; cod_match_id: string | null; team_match_id: string | null; context: string | null } = { mode: null, cod_match_id: null, team_match_id: null, context: null };
  if (input.match && typeof input.match === 'object') {
    const found = (await recentMatchesFor(userId)).find((m) => m.kind === input.match!.kind && m.id === input.match!.id);
    if (!found) throw new HttpError(400, 'INVALID_CLIP_MATCH', 'Ce match ne fait pas partie de tes matchs récents.');
    link =
      found.kind === 'classe'
        ? { mode: 'classe', cod_match_id: found.id, team_match_id: null, context: found.label }
        : { mode: found.tournament ? 'tournoi' : 'division', cod_match_id: null, team_match_id: found.id, context: found.label };
  }

  const { data, error } = await supabase
    .from('clips')
    .insert({ user_id: userId, url: parsed.url, provider: parsed.provider, video_id: parsed.videoId, title, ...link })
    .select(COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') throw new HttpError(409, 'CLIP_EXISTS', 'Tu as déjà ajouté ce clip.');
    throw fromDbError(error);
  }
  return (await present([data as ClipRow], userId))[0];
}

/** Retrait (caché partout, gardé en base) : l'auteur, ou l'équipe (admin, staff). */
export async function removeClip(userId: string, role: Role, clipId: string) {
  const row = unwrap(await supabase.from('clips').select('id, user_id, title').eq('id', clipId).is('removed_at', null).maybeSingle()) as { id: string; user_id: string; title: string } | null;
  if (!row) throw new HttpError(404, 'CLIP_NOT_FOUND', 'Clip introuvable.');
  const moderator = MODERATORS.includes(role);
  if (row.user_id !== userId && !moderator) throw new HttpError(403, 'FORBIDDEN', 'Seul son auteur ou l’équipe SixSence peut retirer ce clip.');
  unwrap(await supabase.from('clips').update({ removed_at: new Date().toISOString(), removed_by: userId }).eq('id', clipId));
  return { removed: true };
}

/** Vote « 🔥 » : ajouté ou retiré ; pas sur ses propres clips. */
export async function toggleVote(userId: string, clipId: string) {
  const row = unwrap(await supabase.from('clips').select('id, user_id').eq('id', clipId).is('removed_at', null).maybeSingle()) as { id: string; user_id: string } | null;
  if (!row) throw new HttpError(404, 'CLIP_NOT_FOUND', 'Clip introuvable.');
  if (row.user_id === userId) throw new HttpError(409, 'OWN_CLIP', 'Tu ne peux pas voter pour ton propre clip.');
  const { data: existing } = await supabase.from('clip_votes').select('clip_id').eq('clip_id', clipId).eq('user_id', userId).maybeSingle();
  if (existing) unwrap(await supabase.from('clip_votes').delete().eq('clip_id', clipId).eq('user_id', userId));
  else unwrap(await supabase.from('clip_votes').insert({ clip_id: clipId, user_id: userId }));
  const { count } = await supabase.from('clip_votes').select('clip_id', { count: 'exact', head: true }).eq('clip_id', clipId);
  return { voted: !existing, votes: count ?? 0 };
}

/** Signalement : message au salon staff avec le lien du clip et le motif. */
export async function reportClip(userId: string, clipId: string, body: unknown) {
  const reason = typeof (body as { reason?: unknown } | null)?.reason === 'string' ? String((body as { reason: string }).reason).slice(0, 300).trim() : '';
  const row = unwrap(await supabase.from('clips').select('id, user_id, title, url').eq('id', clipId).is('removed_at', null).maybeSingle()) as { id: string; user_id: string; title: string; url: string } | null;
  if (!row) throw new HttpError(404, 'CLIP_NOT_FOUND', 'Clip introuvable.');
  const { data: people } = await supabase.from('users').select('id, username').in('id', [userId, row.user_id]);
  const name = (id: string) => ((people ?? []) as { id: string; username: string }[]).find((p) => p.id === id)?.username ?? 'joueur';
  await notifyStaff(
    `🚩 **Clip signalé** par ${name(userId)} : « ${row.title} » de ${name(row.user_id)}\n${reason ? `Motif : ${reason}\n` : ''}${row.url}\nRetirer : ${config.siteUrl}/clips?c=${row.id}`,
  );
  return { reported: true };
}

/** Derniers clips pour le fil d'activité de l'accueil. */
export async function recentClipsForFeed(limit = 6) {
  const rows = unwrap(await supabase.from('clips').select(COLUMNS).is('removed_at', null).order('created_at', { ascending: false }).limit(limit)) as ClipRow[];
  return present(rows, null);
}
