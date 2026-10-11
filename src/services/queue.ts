import { config, playersNeeded } from '../config.js';
import { fromDbError, unwrap } from '../errors.js';
import { bus, type CodMatch, type ReadyCheckFailure } from '../events.js';
import { supabase } from '../supabase.js';

/** Ce qu'un joueur a besoin de savoir pour afficher la page de file d'attente. */
export interface QueueState {
  /** Nombre de joueurs actuellement en file. */
  size: number;
  /** Nombre de joueurs requis pour lancer un match (10 en 5v5). */
  needed: number;
  inQueue: boolean;
  joinedAt: string | null;
  /** Match en cours du joueur, s'il en a un (il doit le terminer avant de relancer). */
  activeMatchId: string | null;
  /** Fin de l'exclusion temporaire de la file (sanction), ou null. */
  bannedUntil: string | null;
}

export async function getQueueSize(): Promise<number> {
  const { count, error } = await supabase.from('cod_queue').select('user_id', { count: 'exact', head: true });
  if (error) throw fromDbError(error);
  return count ?? 0;
}

export async function getQueueState(userId: string): Promise<QueueState> {
  const [size, entry, active, profile] = await Promise.all([
    getQueueSize(),
    supabase.from('cod_queue').select('joined_at').eq('user_id', userId).maybeSingle(),
    supabase.rpc('cod_active_match_id', { p_user: userId }),
    supabase.from('cod_profiles').select('banned_until').eq('user_id', userId).maybeSingle(),
  ]);
  if (entry.error) throw fromDbError(entry.error);
  if (active.error) throw fromDbError(active.error);
  if (profile.error) throw fromDbError(profile.error);

  const bannedUntil = (profile.data?.banned_until as string | null | undefined) ?? null;
  return {
    size,
    needed: playersNeeded,
    inQueue: Boolean(entry.data),
    joinedAt: (entry.data?.joined_at as string | undefined) ?? null,
    activeMatchId: (active.data as string | null) ?? null,
    bannedUntil: bannedUntil && new Date(bannedUntil).getTime() > Date.now() ? bannedUntil : null,
  };
}

/**
 * Fait entrer un joueur dans la file, puis tente de lancer un match.
 * Les vérifications (profil complet, pas de match en cours) sont faites en SQL.
 */
export async function joinQueue(userId: string): Promise<void> {
  unwrap(await supabase.rpc('cod_join_queue', { p_user: userId }));
  bus.emit('queue:user', userId);
  await runMatchmaking();
  bus.emit('queue:changed');
}

/** Retire un joueur de la file. Renvoie true s'il y était. */
export async function leaveQueue(userId: string): Promise<boolean> {
  const removed = unwrap(await supabase.from('cod_queue').delete().eq('user_id', userId).select('user_id'));
  const wasInQueue = Array.isArray(removed) && removed.length > 0;
  if (wasInQueue) {
    bus.emit('queue:user', userId);
    bus.emit('queue:changed');
  }
  return wasInQueue;
}

/**
 * Crée autant de matchs que la file le permet. La fonction SQL
 * cod_try_create_match fait tout le travail de façon atomique : choix des
 * joueurs les plus anciens, équipes aléatoires, carte et mode aléatoires.
 * Chaque match démarre par une vérification « Prêt ? » (config.cod.readySeconds).
 */
export async function runMatchmaking(): Promise<void> {
  // Garde-fou : on ne boucle jamais indéfiniment, même en cas de comportement inattendu.
  for (let round = 0; round < 20; round += 1) {
    const created = unwrap(
      await supabase.rpc('cod_try_create_match', {
        p_team_size: config.cod.teamSize,
        p_maps: config.cod.maps,
        p_modes: config.cod.modes,
        p_ready_seconds: config.cod.readySeconds,
      }),
    ) as CodMatch[] | null;

    const match = created?.[0];
    if (!match) return;

    console.log(`[matchmaking] match ${match.id} trouvé : ${match.map} / ${match.mode}, vérification ouverte`);
    bus.emit('match:found', match);
  }
}

/**
 * Clôt les vérifications « Prêt ? » expirées (appelé toutes les quelques secondes) :
 * match annulé, joueurs prêts remis en tête de file, absents sanctionnés.
 * Relance ensuite le matchmaking, puisque la file a pu se remplir.
 */
export async function expireReadyChecks(): Promise<void> {
  const { data, error } = await supabase.rpc('cod_expire_ready_checks');
  if (error) {
    console.error('[ready]', error.message);
    return;
  }
  const failures = (data ?? []) as ReadyCheckFailure[];
  if (failures.length === 0) return;

  for (const failure of failures) {
    console.log(`[ready] match ${failure.match_id} annulé : ${failure.missing.length} joueur(s) absent(s)`);
    bus.emit('match:aborted', failure);
  }
  await runMatchmaking();
  bus.emit('queue:changed');
}

/** Vide la file. Appelé au démarrage : après un redémarrage, plus personne n'est connecté. */
export async function clearQueue(): Promise<void> {
  const { error } = await supabase.from('cod_queue').delete().not('user_id', 'is', null);
  if (error) throw fromDbError(error);
}
