import type { AnnounceType } from './announcements.js';

/**
 * Panneau « Choisis tes notifications » : chaque bouton ajoute ou retire un rôle 🔔 déjà utilisé par les annonces.
 * Règles et textes sans accès au réseau (testés dans discordNotifyPolicy.test.ts), envoi dans notifyPanel.ts.
 */

const PREFIX = 'notif:';
const GOLD = 0xd4af37;

export interface NotifyChoice {
  type: AnnounceType;
  label: string;
  emoji: string;
  hint: string;
}

export const NOTIFY_CHOICES: NotifyChoice[] = [
  { type: 'annonce', label: 'Annonces', emoji: '📣', hint: 'Annonces du serveur et coupes' },
  { type: 'gta', label: 'Événements GTA', emoji: '🚘', hint: 'Événements GTA VI' },
  { type: 'nouveautes', label: 'Nouveautés', emoji: '✨', hint: 'Mises à jour du site' },
  { type: 'saison', label: 'Fin de saison', emoji: '🏁', hint: 'Fin de saison et récompenses' },
];

/** Choix correspondant à un bouton du panneau (null : ce bouton n'est pas le nôtre). */
export function parseNotifyChoice(customId: string | undefined): NotifyChoice | null {
  if (!customId?.startsWith(PREFIX)) return null;
  return NOTIFY_CHOICES.find((choice) => choice.type === customId.slice(PREFIX.length)) ?? null;
}

export function notifyPanelMessage() {
  return {
    embeds: [
      {
        title: '🔔 Choisis tes notifications',
        description: [
          ...NOTIFY_CHOICES.map((choice) => `${choice.emoji} **${choice.label}** · ${choice.hint}`),
          '',
          '*Clique une fois pour activer, une seconde fois pour couper.*',
        ].join('\n'),
        color: GOLD,
      },
    ],
    components: [
      {
        type: 1,
        components: NOTIFY_CHOICES.map((choice) => ({ type: 2, style: 2, label: choice.label, emoji: { name: choice.emoji }, custom_id: `${PREFIX}${choice.type}` })),
      },
    ],
  };
}

export function notifyReply(choice: NotifyChoice, added: boolean): string {
  return added ? `🔔 **${choice.label}** activé.` : `🔕 **${choice.label}** coupé.`;
}
