import { EventEmitter } from 'node:events';

/** Ligne de la table cod_matches, telle que renvoyée par Supabase. */
export interface CodMatch {
  id: string;
  status: 'in_progress' | 'awaiting_confirmation' | 'disputed' | 'completed' | 'cancelled';
  map: string;
  mode: string;
  team_size: number;
  team_a: string[];
  team_b: string[];
  winner: 'A' | 'B' | null;
  reported_winner: 'A' | 'B' | null;
  reported_by: string | null;
  reported_at: string | null;
  confirmed_by: string | null;
  points_changes: Record<string, number>;
  created_at: string;
  completed_at: string | null;
}

/**
 * Événements internes du serveur. Les services (file d'attente, matchs)
 * émettent ; le hub WebSocket écoute et prévient les navigateurs.
 * Ce découplage évite que les services dépendent du WebSocket.
 */
interface BusEvents {
  /** La taille de la file a changé : à diffuser à tout le monde. */
  'queue:changed': [];
  /** L'état d'un joueur précis a changé (entré ou sorti de la file). */
  'queue:user': [userId: string];
  /** Un match vient d'être créé : prévenir ses joueurs. */
  'match:found': [match: CodMatch];
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
