/** Arrivées et départs du serveur Discord : règles pures, testées. */

export interface KnownMember {
  id: string;
  present: boolean;
}

export interface GuildMember {
  id: string;
  joinedAt: number;
}

/** Rattrapage après une coupure : au-delà, on n'écrit plus rien pour ne pas inonder les salons. */
export const MAX_CATCH_UP = 10;
/** Une arrivée plus ancienne n'est plus annoncée : on la note sans message. */
export const CATCH_UP_WINDOW_MS = 24 * 3600_000;
/** Plus de départs d'un coup : liste sans doute incomplète, on ne touche à rien. */
export const MAX_DEPARTURES = 20;

export interface MemberDiff {
  /** Arrivées à annoncer. */
  welcome: GuildMember[];
  /** Arrivées à noter sans message (trop anciennes ou au-delà de la limite). */
  silent: GuildMember[];
  /** Départs à annoncer. */
  departed: string[];
  /** Liste jugée peu fiable : rien n'est appliqué. */
  suspicious: boolean;
}

/** Compare la liste enregistrée à celle du serveur, après une connexion ou une coupure. */
export function diffMembers(known: KnownMember[], current: GuildMember[], now: number): MemberDiff {
  const present = new Set(known.filter((member) => member.present).map((member) => member.id));
  const here = new Set(current.map((member) => member.id));
  const arrivals = current.filter((member) => !present.has(member.id)).sort((a, b) => b.joinedAt - a.joinedAt);
  const departed = [...present].filter((id) => !here.has(id));
  if (departed.length > MAX_DEPARTURES || (present.size > 0 && current.length === 0)) {
    return { welcome: [], silent: [], departed: [], suspicious: true };
  }
  const recent = arrivals.filter((member) => now - member.joinedAt <= CATCH_UP_WINDOW_MS);
  const welcome = recent.slice(0, MAX_CATCH_UP);
  const announced = new Set(welcome.map((member) => member.id));
  return { welcome, silent: arrivals.filter((member) => !announced.has(member.id)), departed: departed.slice(0, MAX_CATCH_UP), suspicious: false };
}

/** Pseudo sans mise en forme Discord (étoiles, tirets, mentions…), jamais vide. */
export function plainName(name: string | null | undefined): string {
  const clean = (name ?? '').replace(/[\\*_~`|>#@:[\]()]/g, '').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, 40).join('').trim() || 'Un membre';
}

export function welcomeText(userId: string): string {
  return [
    `👁️ **Bienvenue sur SixSence, <@${userId}> !**`,
    '',
    '**Call of Duty Hardcore**',
    '• Classé, Division & Tournois',
    '**Grand Theft Auto VI**',
    '• Événements, sessions organisées et rassemblements dès la sortie du jeu',
    '',
    '*Bon jeu, soldat ! 🫡*',
  ].join('\n');
}

export function goodbyeText(name: string | null | undefined): string {
  return `**${plainName(name)}** a quitté SixSence. Bonne continuation, la porte reste ouverte. 👋`;
}

/** Image de bienvenue du site : avatar Discord, pseudo et numéro de membre sur le fond SixSence. */
export function welcomeImageUrl(siteUrl: string, userId: string, avatar: string | null | undefined, name: string | null | undefined, memberNumber = 0): string {
  const query = new URLSearchParams({ id: userId, name: plainName(name) });
  if (avatar) query.set('a', avatar);
  if (memberNumber > 0) query.set('n', String(memberNumber));
  return `${siteUrl}/api/og/bienvenue?${query.toString()}`;
}
