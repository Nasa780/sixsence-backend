import { config } from '../config.js';
import { supabase } from '../supabase.js';
import { discord, discordEnabled, discordIds } from './discord.js';

/**
 * Rôle Discord de chaque équipe (« [TAG] Nom », couleur de l'équipe) : créé avec l'équipe, donné à
 * chaque joueur qui la rejoint, retiré au départ, renommé avec l'équipe, supprimé à la dissolution.
 * Tout est « au mieux » : une erreur Discord n'empêche jamais l'action sur le site.
 */

const { guildId } = config.discord;
const roleName = (team: { tag: string; name: string }) => `[${team.tag}] ${team.name}`.slice(0, 100);
const colorOf = (hex: string) => Number.parseInt(hex.replace('#', ''), 16) || 0xd4af37;

async function teamOf(teamId: string) {
  const { data } = await supabase.from('teams').select('id, name, tag, color, discord_role_id, disbanded_at').eq('id', teamId).maybeSingle();
  return data as { id: string; name: string; tag: string; color: string; discord_role_id: string | null; disbanded_at: string | null } | null;
}

/** Crée le rôle s'il manque, sinon remet son nom et sa couleur à jour. Renvoie son identifiant. */
async function ensureRole(teamId: string): Promise<string | null> {
  const team = await teamOf(teamId);
  if (!team || team.disbanded_at) return null;
  const body = { name: roleName(team), color: colorOf(team.color), mentionable: false, hoist: false };
  if (team.discord_role_id) {
    try {
      await discord(`/guilds/${guildId}/roles/${team.discord_role_id}`, { method: 'PATCH', body });
      return team.discord_role_id;
    } catch {
      // Rôle supprimé à la main sur Discord : on le recrée.
    }
  }
  const role = (await discord(`/guilds/${guildId}/roles`, { method: 'POST', body })) as { id: string };
  await supabase.from('teams').update({ discord_role_id: role.id }).eq('id', teamId);
  return role.id;
}

async function setMembers(roleId: string, userIds: string[], method: 'PUT' | 'DELETE'): Promise<void> {
  for (const discordId of (await discordIds(userIds)).values()) {
    await discord(`/guilds/${guildId}/members/${discordId}/roles/${roleId}`, { method }).catch(() => undefined);
  }
}

function safely(label: string, task: () => Promise<void>): void {
  if (!discordEnabled || !config.teams.enabled) return;
  void task().catch((caught) => console.warn(`[discord] rôle d'équipe : ${label} impossible`, (caught as Error).message));
}

/** Équipe créée, renommée ou recolorée : rôle créé ou mis à jour (et donné à tout l'effectif). */
export function syncTeamRole(teamId: string): void {
  safely('mise à jour', async () => {
    const roleId = await ensureRole(teamId);
    if (!roleId) return;
    const { data } = await supabase.from('team_members').select('user_id').eq('team_id', teamId);
    await setMembers(roleId, ((data ?? []) as { user_id: string }[]).map((row) => row.user_id), 'PUT');
  });
}

/** Un joueur rejoint l'équipe. */
export function addTeamRole(teamId: string, userId: string): void {
  safely('ajout', async () => {
    const roleId = await ensureRole(teamId);
    if (roleId) await setMembers(roleId, [userId], 'PUT');
  });
}

/** Un joueur quitte l'équipe (départ ou exclusion). */
export function removeTeamRole(teamId: string, userId: string): void {
  safely('retrait', async () => {
    const team = await teamOf(teamId);
    if (team?.discord_role_id) await setMembers(team.discord_role_id, [userId], 'DELETE');
  });
}

/** Équipe dissoute : rôle supprimé du serveur. */
export function deleteTeamRole(teamId: string): void {
  safely('suppression', async () => {
    const team = await teamOf(teamId);
    if (!team?.discord_role_id) return;
    await discord(`/guilds/${guildId}/roles/${team.discord_role_id}`, { method: 'DELETE' }).catch(() => undefined);
    await supabase.from('teams').update({ discord_role_id: null }).eq('id', teamId);
  });
}
