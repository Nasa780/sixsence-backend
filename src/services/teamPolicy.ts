/**
 * Équipes (Division) : règles pures, testées dans teamPolicy.test.ts.
 *
 *   - accès (créer ou rejoindre) : identifiant Activision et Discord liés (aucun nombre de matchs
 *     classés exigé depuis le 2026-10-20), aucune exclusion en cours, pas déjà dans une équipe, 24 h après un départ ;
 *   - 8 joueurs au plus dont 4 titulaires ;
 *   - rôles : Leader (plusieurs possibles) ou Joueur ; le créateur porte la couronne, il est Leader
 *     d'office et seul à nommer les Leaders, renommer l'équipe, transmettre la couronne ou dissoudre.
 */

export const TEAM_LIMITS = { maxMembers: 8, maxStarters: 4, leaveCooldownHours: 24, maxPendingInvites: 20 } as const;

export const TEAM_COLORS = ['#d4af37', '#5cc8ff', '#f87171', '#a78bfa', '#4ade80', '#facc15', '#fb923c', '#f0abfc', '#e5e7eb'];
export const SOCIAL_KEYS = ['discord', 'x', 'twitch', 'youtube', 'tiktok'] as const;
export const TEAM_REPORT_REASONS: Record<string, string> = {
  name: 'Nom ou tag inapproprié',
  logo: 'Logo inapproprié',
  banner: 'Bannière inappropriée',
  description: 'Description inappropriée',
  other: 'Autre',
};

export class TeamInputError extends Error {}

export interface TeamInput {
  name?: string;
  tag?: string;
  description?: string | null;
  color?: string;
  socials?: Record<string, string>;
}

const clean = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Valide les champs d'une fiche (création : nom et tag obligatoires ; modification : champs fournis seulement). */
export function parseTeamInput(body: unknown, { create = false } = {}): TeamInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const out: TeamInput = {};

  if (create || input.name !== undefined) {
    if (typeof input.name !== 'string') throw new TeamInputError("Indique le nom de l'équipe.");
    const name = clean(input.name);
    if (name.length < 3 || name.length > 24) throw new TeamInputError("Le nom de l'équipe doit contenir entre 3 et 24 caractères.");
    if (!/^[\p{L}\p{N} '._-]+$/u.test(name)) throw new TeamInputError('Le nom ne peut contenir que des lettres, chiffres, espaces et . _ - \'.');
    out.name = name;
  }
  if (create || input.tag !== undefined) {
    if (typeof input.tag !== 'string') throw new TeamInputError('Indique le tag de l’équipe.');
    const tag = input.tag.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,4}$/.test(tag)) throw new TeamInputError('Le tag fait 2 à 4 lettres ou chiffres (ex. NXS).');
    out.tag = tag;
  }
  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== 'string') throw new TeamInputError('Description invalide.');
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (description.length > 300) throw new TeamInputError('La description fait 300 caractères au plus.');
    out.description = description || null;
  }
  if (create || input.color !== undefined) {
    const color: string = typeof input.color === 'string' ? input.color.toLowerCase() : TEAM_COLORS[0]!;
    if (!TEAM_COLORS.includes(color)) throw new TeamInputError('Couleur inconnue.');
    out.color = color;
  }
  if (input.socials !== undefined) {
    if (!input.socials || typeof input.socials !== 'object' || Array.isArray(input.socials)) throw new TeamInputError('Liens invalides.');
    const socials: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.socials as Record<string, unknown>)) {
      if (!(SOCIAL_KEYS as readonly string[]).includes(key)) throw new TeamInputError('Réseau inconnu.');
      if (value === '' || value === null) continue;
      if (typeof value !== 'string' || value.length > 200 || !/^https:\/\/[^\s]+$/.test(value)) throw new TeamInputError('Chaque lien doit commencer par https://.');
      socials[key] = value;
    }
    out.socials = socials;
  }
  return out;
}

export interface TeamEligibilityInput {
  activisionId: string | null;
  discordId: string | null;
  bannedUntil: string | null;
  teamLeftAt: string | null;
  inTeam: boolean;
}

/** Conditions d'accès non remplies (vide = accès autorisé). */
export function missingRequirements(input: TeamEligibilityInput, now = Date.now()): string[] {
  const missing: string[] = [];
  if (input.inTeam) missing.push('Tu fais déjà partie d’une équipe.');
  if (!input.activisionId) missing.push('Renseigne ton identifiant Activision.');
  if (!input.discordId) missing.push('Connecte ton compte Discord.');
  if (input.bannedUntil && new Date(input.bannedUntil).getTime() > now) missing.push('Tu as une exclusion en cours.');
  const cooldownEnd = leaveCooldownEnd(input.teamLeftAt);
  if (cooldownEnd && cooldownEnd > now) missing.push(`Tu as quitté une équipe il y a moins de ${TEAM_LIMITS.leaveCooldownHours} h.`);
  return missing;
}

/** Fin du délai après un départ (ms), ou null. */
export function leaveCooldownEnd(teamLeftAt: string | null): number | null {
  return teamLeftAt ? new Date(teamLeftAt).getTime() + TEAM_LIMITS.leaveCooldownHours * 3600_000 : null;
}

export interface TeamActor {
  role: 'leader' | 'player';
  isOwner: boolean;
}

export type TeamAction = 'invite' | 'answerRequest' | 'setStarter' | 'edit' | 'kick' | 'setRole' | 'rename' | 'transfer' | 'disband';

/** Un membre peut-il faire cette action (sur ce membre, le cas échéant) ? */
export function canDo(actor: TeamActor | null, action: TeamAction, target: TeamActor | null = null): boolean {
  if (!actor) return false;
  const leader = actor.role === 'leader' || actor.isOwner;
  switch (action) {
    case 'invite':
    case 'answerRequest':
    case 'setStarter':
    case 'edit':
      return leader;
    case 'kick':
      // Personne n'exclut la couronne ; seule la couronne exclut un Leader.
      if (!leader || !target || target.isOwner) return false;
      return target.role !== 'leader' || actor.isOwner;
    case 'setRole':
      return actor.isOwner && Boolean(target) && !target!.isOwner;
    case 'rename':
    case 'transfer':
    case 'disband':
      return actor.isOwner;
  }
}

/** Logo ou bannière : uniquement une image publique du bucket team-media envoyée par ce joueur. */
export function isOwnTeamMedia(url: unknown, supabaseUrl: string, userId: string): url is string {
  if (typeof url !== 'string' || url.length > 400) return false;
  const prefix = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/team-media/${userId}/`;
  return url.startsWith(prefix) && /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/.test(url.slice(prefix.length));
}
