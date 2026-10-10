import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

/**
 * Client Supabase "admin" : il utilise la clé secrète, qui contourne RLS.
 * Il ne doit exister que côté serveur. Toute écriture passe par lui, le plus
 * souvent via les fonctions SQL de supabase/migrations/0001_init.sql.
 */
export const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
