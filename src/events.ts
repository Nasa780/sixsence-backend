import { EventEmitter } from 'node:events';
import type { Party } from './services/parties.js';

/** Ligne de la table cod_matches, telle que renvoyée par Supabase. */
export interface CodMatch {
  id: string;
  status: 'ready_check' | 'in_progress' | 'awaiting_confirmation' | 'disputed' | 'completed' | 'cancelled';
  map: string;
  mode: string;
  team_size: number;
  /** File du match (« 2v2 », « 5v5 »…). */
  format: string | null;
  /** Groupe de chaque joueur au moment du match ({ joueur: groupe }). */
  groups: Record<string, string>;
  /** Taille du groupe de chaque joueur ({ joueur: 1 à 5 }), utilisée par le barème. */
  group_sizes: Record<string, number>;
  team_a: string[];
  team_b: string[];
  winner: 'A' | 'B' | null;
  reported_winner: 'A' | 'B' | null;
  reported_by: string | null;
  reported_at: string | null;
  confirmed_by: string | null;
  points_changes: Record<string, number>;
  ready_deadline: string | null;
  ready_users: string[];
  started_at: string | null;
  cancel_reason: string | null;
  season_id: number | null;
  discord_channels: Record<string, string>;
  discord_done: boolean;
  created_at: string;
  completed_at: string | null;
}

/** Vérification « Prêt ? » expirée : qui avait accepté, qui manquait. */
export interface ReadyCheckFailure {
  match_id: string;
  /** Remis en tête de file (tout leur groupe avait accepté). */
  accepted: string[];
  missing: string[];
  /** Avaient accepté, mais un coéquipier de leur groupe manquait : libérés, hors file. */
  released: string[];
}

/**
 * Événements internes du serveur. Les services (file d'attente, matchs)
 * émettent ; le hub WebSocket et l'intégration Discord écoutent.
 * Ce découplage évite que les services dépendent du WebSocket.
 */
interface BusEvents {
  /** La taille de la file a changé : à diffuser à tout le monde. */
  'queue:changed': [];
  /** L'état d'un joueur précis a changé (entré ou sorti de la file). */
  'queue:user': [userId: string];
  /** « Toujours là ? » : la recherche de ces joueurs s'arrête bientôt sans confirmation. */
  'queue:warned': [userIds: string[]];
  /** Recherche arrêtée faute de confirmation (durée maximale atteinte). */
  'queue:expired': [userIds: string[]];
  /** Un match vient d'être créé (vérification « Prêt ? » ouverte) : prévenir ses joueurs. */
  'match:found': [match: CodMatch];
  /** Un joueur a accepté : nouveau décompte. */
  'match:ready': [match: CodMatch];
  /** Tous les joueurs ont accepté : le match démarre. */
  'match:start': [match: CodMatch];
  /** Vérification expirée : match annulé. */
  'match:aborted': [failure: ReadyCheckFailure];
  /** Un ou plusieurs matchs viennent de se terminer (résultat validé ou annulation). */
  'match:closed': [];
  /** Un match terminé vient d'être traité (salons supprimés, résultat publié) : rôles Discord à jour. */
  'match:finalized': [match: CodMatch];
  /** Match annulé faute de résultat déclaré à temps (traité par la tâche Discord). */
  'match:abandoned': [match: CodMatch];
  /** Un groupe a changé (null = dissous) ; alsoNotify : joueurs qui viennent de le quitter. */
  'party:changed': [party: Party | null, alsoNotify: string[]];
  /** Message d'information à afficher à certains joueurs (recherche annulée…). */
  notice: [userIds: string[], message: string];
}

class Bus {
  private readonly emitter = new EventEmitter();

  on<K extends keyof BusEvents>(event: K, listener: (...args: BusEvents[K]) => void | Promise<void>): void {
    this.emitter.on(event, (...args: unknown[]) => {
      // Une erreur dans un écouteur ne doit jamais faire tomber le serveur.
      Promise.resolve()
        .then(() => listener(...(args as BusEvents[K])))
        .catch((error) => console.error(`[bus] ${event}`, error));
    });
  }

  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.emitter.emit(event, ...args);
  }
}

export const bus = new Bus();
