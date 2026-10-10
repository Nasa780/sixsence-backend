import { HttpError, fromDbError, unwrap } from '../errors.js';
import { supabase } from '../supabase.js';

export interface GtaEvent {
  id: string;
  title: string;
  description: string | null;
  category: string;
  location: string | null;
  cover_url: string | null;
  starts_at: string;
  ends_at: string | null;
  max_slots: number | null;
  status: 'draft' | 'published' | 'cancelled';
  created_at: string;
  /** Nombre d'inscrits, calculé à la lecture. */
  registered_count: number;
}

/** Supabase renvoie le décompte sous la forme gta_registrations: [{ count }] ; on l'aplatit. */
function withCount(row: Record<string, unknown>): GtaEvent {
  const { gta_registrations: registrations, ...event } = row;
  const count = Array.isArray(registrations) ? (registrations[0] as { count?: number } | undefined)?.count : 0;
  return { ...(event as unknown as Omit<GtaEvent, 'registered_count'>), registered_count: count ?? 0 };
}

export type EventScope = 'upcoming' | 'past' | 'all';

/** Liste les événements publiés (les brouillons ne sortent jamais de cette API). */
export async function listEvents(scope: EventScope): Promise<GtaEvent[]> {
  let query = supabase.from('gta_events').select('*, gta_registrations(count)').neq('status', 'draft');
  const now = new Date().toISOString();
  if (scope === 'upcoming') query = query.gte('starts_at', now).order('starts_at', { ascending: true });
  else if (scope === 'past') query = query.lt('starts_at', now).order('starts_at', { ascending: false });
  else query = query.order('starts_at', { ascending: true });

  const rows = unwrap(await query.limit(100)) as Record<string, unknown>[] | null;
  return (rows ?? []).map(withCount);
}

export async function getEvent(eventId: string): Promise<GtaEvent> {
  const row = unwrap(
    await supabase
      .from('gta_events')
      .select('*, gta_registrations(count)')
      .eq('id', eventId)
      .neq('status', 'draft')
      .maybeSingle(),
  ) as Record<string, unknown> | null;
  if (!row) throw new HttpError(404, 'EVENT_NOT_FOUND', 'Événement introuvable.');
  return withCount(row);
}

/** Inscrit un joueur. Le contrôle de capacité est fait en SQL, sous verrou. */
export async function registerToEvent(eventId: string, userId: string): Promise<number> {
  return unwrap(await supabase.rpc('gta_register', { p_event: eventId, p_user: userId })) as number;
}

export async function unregisterFromEvent(eventId: string, userId: string): Promise<void> {
  const { error } = await supabase.from('gta_registrations').delete().eq('event_id', eventId).eq('user_id', userId);
  if (error) throw fromDbError(error);
}

export interface NewEventInput {
  title: string;
  description: string | null;
  category: string;
  location: string | null;
  cover_url: string | null;
  starts_at: string;
  ends_at: string | null;
  max_slots: number | null;
  status: 'draft' | 'published';
}

/** Valide le corps d'une requête de création d'événement (admin). */
export function parseNewEvent(body: unknown): NewEventInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const invalid = (message: string) => new HttpError(400, 'INVALID_EVENT', message);

  const text = (key: string, max: number): string | null => {
    const value = input[key];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > max) throw invalid(`Champ invalide : ${key}.`);
    return value.trim();
  };
  const date = (key: string): string | null => {
    const value = input[key];
    if (value === undefined || value === null || value === '') return null;
    const parsed = typeof value === 'string' ? new Date(value) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw invalid(`Date invalide : ${key}.`);
    return parsed.toISOString();
  };

  const title = text('title', 120);
  if (!title || title.length < 3) throw invalid('Le titre doit contenir entre 3 et 120 caractères.');

  const startsAt = date('starts_at');
  if (!startsAt) throw invalid('La date de début est obligatoire.');
  const endsAt = date('ends_at');
  if (endsAt && endsAt <= startsAt) throw invalid('La date de fin doit suivre la date de début.');

  const coverUrl = text('cover_url', 500);
  if (coverUrl && !/^https:\/\//i.test(coverUrl)) throw invalid("L'image doit être une adresse https.");

  let maxSlots: number | null = null;
  if (input.max_slots !== undefined && input.max_slots !== null && input.max_slots !== '') {
    const parsed = Number(input.max_slots);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) throw invalid('Nombre de places invalide.');
    maxSlots = parsed;
  }

  return {
    title,
    description: text('description', 5000),
    category: text('category', 40) ?? 'session',
    location: text('location', 200),
    cover_url: coverUrl,
    starts_at: startsAt,
    ends_at: endsAt,
    max_slots: maxSlots,
    status: input.status === 'draft' ? 'draft' : 'published',
  };
}

export async function createEvent(input: NewEventInput, createdBy: string): Promise<GtaEvent> {
  const row = unwrap(
    await supabase
      .from('gta_events')
      .insert({ ...input, created_by: createdBy })
      .select('*')
      .single(),
  ) as Record<string, unknown>;
  return withCount(row);
}
