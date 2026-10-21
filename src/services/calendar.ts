import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { supabase } from '../supabase.js';
import { anubisCapacity, CHECKIN_MINUTES } from './tournamentPolicy.js';
import { parisInstant } from './tournaments.js';

/**
 * Calendrier public (GET /calendar?from=&to=, GET /calendar.ics) : coupes Horus et Anubis (ouvertes, et
 * rendez-vous récurrents à venir quand les coupes automatiques sont activées), tournoi de fin de saison,
 * événements GTA 6 publiés, fin de saison et début du verrouillage des transferts, top de la semaine.
 * Tout est recalculé depuis les tables existantes : rien à saisir.
 */

export type CalendarKind = 'coupe' | 'gta' | 'saison' | 'rdv';

export interface CalendarEvent {
  id: string;
  kind: CalendarKind;
  title: string;
  subtitle: string | null;
  startsAt: string;
  endsAt: string | null;
  href: string;
  cup: { type: 'horus' | 'anubis' | 'saison'; status: string; registered: number | null; capacity: number | null; checkInAt: string } | null;
}

const MAX_DAYS = 62;
const DAY = 86_400_000;
const parisDay = (at: Date) => at.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

export async function calendarEvents(fromInput: unknown, toInput: unknown): Promise<CalendarEvent[]> {
  const from = new Date(typeof fromInput === 'string' ? fromInput : Date.now() - DAY);
  const to = new Date(typeof toInput === 'string' ? toInput : from.getTime() + 35 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new HttpError(400, 'INVALID_RANGE', 'Période invalide.');
  if (to.getTime() - from.getTime() > MAX_DAYS * DAY) throw new HttpError(400, 'INVALID_RANGE', `Période de ${MAX_DAYS} jours au plus.`);
  const range = [from.toISOString(), to.toISOString()] as const;

  const [tournaments, schedules, auto, gta, season] = await Promise.all([
    supabase.from('tournaments').select('id, kind, name, size, team_size, status, starts_at, schedule_id, best_of, final_best_of').gte('starts_at', range[0]).lte('starts_at', range[1]),
    supabase.from('cup_schedules').select('id, kind, name, weekday, start_time, size, team_size, best_of, final_best_of').eq('active', true),
    supabase.from('app_state').select('value').eq('key', 'cups_auto').maybeSingle(),
    supabase.from('gta_events').select('id, title, category, location, starts_at, ends_at').eq('status', 'published').gte('starts_at', range[0]).lte('starts_at', range[1]),
    supabase.from('seasons').select('id, name, ends_at').eq('is_active', true).maybeSingle(),
  ]);
  const events: CalendarEvent[] = [];

  // Coupes et tournois déjà créés.
  type Cup = { id: string; kind: 'saison' | 'horus' | 'anubis'; name: string; size: number; team_size: number | null; status: string; starts_at: string; schedule_id: string | null; best_of: number; final_best_of: number };
  const cups = ((tournaments.data ?? []) as Cup[]).filter((cup) => cup.status !== 'cancelled');
  for (const cup of cups) {
    const anubis = cup.kind === 'anubis';
    let registered: number | null = null;
    if (cup.status === 'scheduled' || cup.kind === 'saison') {
      const { count } = await supabase.from(anubis ? 'cup_players' : 'tournament_teams').select('tournament_id', { count: 'exact', head: true }).eq('tournament_id', cup.id);
      registered = count ?? 0;
    }
    events.push({
      id: `t-${cup.id}`,
      kind: 'coupe',
      title: cup.name,
      subtitle:
        cup.kind === 'saison'
          ? 'Tournoi de fin de saison · BO3, finale BO5'
          : anubis
            ? `Coupe Anubis · solo, équipes de ${cup.team_size} · BO${cup.best_of}, finale BO${cup.final_best_of}`
            : `Coupe Horus · équipes · BO${cup.best_of}, finale BO${cup.final_best_of}`,
      startsAt: cup.starts_at,
      endsAt: null,
      href: cup.kind === 'saison' ? '/cod/tournoi?coupe=saison' : anubis ? '/cod/tournoi?coupe=anubis' : '/cod/tournoi',
      cup: {
        type: cup.kind,
        status: cup.status,
        registered,
        capacity: anubis ? anubisCapacity(cup.size, cup.team_size ?? config.teams.rosterSize) : cup.size,
        checkInAt: new Date(new Date(cup.starts_at).getTime() - CHECKIN_MINUTES * 60_000).toISOString(),
      },
    });
  }

  // Rendez-vous récurrents à venir (coupes automatiques activées), sauf les jours où la coupe existe déjà.
  if ((auto.data as { value: string } | null)?.value === 'on') {
    type Schedule = { id: string; kind: 'horus' | 'anubis'; name: string; weekday: number; start_time: string; size: number; team_size: number | null; best_of: number; final_best_of: number };
    const opened = new Set(cups.filter((cup) => cup.schedule_id).map((cup) => `${cup.schedule_id}-${parisDay(new Date(cup.starts_at))}`));
    for (const schedule of (schedules.data ?? []) as Schedule[]) {
      for (let t = Math.max(from.getTime(), Date.now()); t <= to.getTime(); t += DAY) {
        const day = parisDay(new Date(t));
        if (new Date(`${day}T12:00:00Z`).getUTCDay() !== schedule.weekday || opened.has(`${schedule.id}-${day}`)) continue;
        const startsAt = parisInstant(day, schedule.start_time);
        if (startsAt < from || startsAt > to || startsAt.getTime() < Date.now()) continue;
        const anubis = schedule.kind === 'anubis';
        events.push({
          id: `s-${schedule.id}-${day}`,
          kind: 'coupe',
          title: schedule.name,
          subtitle: `${anubis ? `Coupe Anubis · solo, équipes de ${schedule.team_size}` : 'Coupe Horus · équipes'} · inscriptions à l’ouverture`,
          startsAt: startsAt.toISOString(),
          endsAt: null,
          href: anubis ? '/cod/tournoi?coupe=anubis' : '/cod/tournoi',
          cup: {
            type: schedule.kind,
            status: 'planned',
            registered: null,
            capacity: anubis ? anubisCapacity(schedule.size, schedule.team_size ?? config.teams.rosterSize) : schedule.size,
            checkInAt: new Date(startsAt.getTime() - CHECKIN_MINUTES * 60_000).toISOString(),
          },
        });
      }
    }
  }

  for (const event of (gta.data ?? []) as { id: string; title: string; category: string; location: string | null; starts_at: string; ends_at: string | null }[]) {
    events.push({
      id: `g-${event.id}`,
      kind: 'gta',
      title: event.title,
      subtitle: ['GTA 6', event.location].filter(Boolean).join(' · '),
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      href: `/gta6/events/${event.id}`,
      cup: null,
    });
  }

  // Fin de saison et verrouillage des transferts.
  const active = season.data as { id: number; name: string; ends_at: string | null } | null;
  if (active?.ends_at) {
    const end = new Date(active.ends_at);
    const lock = new Date(end.getTime() - config.teams.transferLockDays * DAY);
    if (end >= from && end <= to) {
      events.push({ id: `fin-${active.id}`, kind: 'saison', title: `Fin de la ${active.name}`, subtitle: 'Classements archivés, récompenses de saison', startsAt: end.toISOString(), endsAt: null, href: '/cod/leaderboard', cup: null });
    }
    if (config.teams.transferLockDays > 0 && lock >= from && lock <= to) {
      events.push({ id: `verrou-${active.id}`, kind: 'saison', title: 'Transferts verrouillés', subtitle: 'Plus d’arrivée ni de départ dans les équipes jusqu’à la fin de saison', startsAt: lock.toISOString(), endsAt: null, href: '/cod/equipe', cup: null });
    }
  }

  // Top de la semaine (lundi 10 h, heure de Paris).
  for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
    const day = parisDay(new Date(t));
    if (new Date(`${day}T12:00:00Z`).getUTCDay() !== 1) continue;
    const at = parisInstant(day, '10:00');
    if (at < from || at > to || events.some((e) => e.id === `top-${day}`)) continue;
    events.push({ id: `top-${day}`, kind: 'rdv', title: 'Top de la semaine', subtitle: 'Meilleurs joueurs de la semaine annoncés sur Discord', startsAt: at.toISOString(), endsAt: null, href: '/cod/leaderboard', cup: null });
  }

  return events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// --- Fichier .ics (Google Agenda, Apple, Outlook) ---------------------------------------------------

const icsDate = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** Les 60 prochains jours (sans les rendez-vous hebdomadaires), au format iCalendar. */
export async function calendarIcs(): Promise<string> {
  const events = (await calendarEvents(new Date(Date.now() - DAY).toISOString(), new Date(Date.now() + 60 * DAY).toISOString())).filter((e) => e.kind !== 'rdv');
  const stamp = icsDate(new Date().toISOString());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SixSence//Calendrier//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:SixSence', 'X-WR-TIMEZONE:Europe/Paris'];
  for (const event of events) {
    const end = event.endsAt ?? new Date(new Date(event.startsAt).getTime() + 2 * 3600_000).toISOString();
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.id}@sixsence.fr`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDate(event.startsAt)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsText(event.title)}`,
      ...(event.subtitle ? [`DESCRIPTION:${icsText(`${event.subtitle}\n${config.siteUrl}${event.href}`)}`] : []),
      `URL:${config.siteUrl}${event.href}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
