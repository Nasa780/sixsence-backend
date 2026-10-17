import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TeamInputError, canDo, isOwnTeamMedia, missingRequirements, parseTeamInput } from './teamPolicy.js';

const eligible = { rankedMatches: 5, activisionId: 'Nasa#123', discordId: '42', bannedUntil: null, teamLeftAt: null, inTeam: false };
const now = Date.parse('2026-10-17T12:00:00Z');

describe('équipes', () => {
  it('fiche : nom, tag en majuscules, couleur par défaut', () => {
    assert.deepEqual(parseTeamInput({ name: '  Nexus   Squad ', tag: 'nxs' }, { create: true }), { name: 'Nexus Squad', tag: 'NXS', color: '#d4af37' });
    assert.throws(() => parseTeamInput({ name: 'NX', tag: 'NXS' }, { create: true }), TeamInputError);
    assert.throws(() => parseTeamInput({ name: 'Nexus', tag: 'NEXUS' }, { create: true }), TeamInputError);
    assert.throws(() => parseTeamInput({ name: 'Nexus <b>', tag: 'NX' }, { create: true }), TeamInputError);
    assert.throws(() => parseTeamInput({ color: '#123456' }), TeamInputError);
    // Modification : seuls les champs fournis.
    assert.deepEqual(parseTeamInput({ description: '  On recrute  ' }), { description: 'On recrute' });
    assert.deepEqual(parseTeamInput({ socials: { x: 'https://x.com/nxs', twitch: '' } }), { socials: { x: 'https://x.com/nxs' } });
    assert.throws(() => parseTeamInput({ socials: { x: 'javascript:alert(1)' } }), TeamInputError);
  });

  it('accès : 5 matchs classés, Activision, Discord, pas d’exclusion, 24 h après un départ', () => {
    assert.deepEqual(missingRequirements(eligible, now), []);
    assert.equal(missingRequirements({ ...eligible, rankedMatches: 4 }, now).length, 1);
    assert.equal(missingRequirements({ ...eligible, activisionId: null, discordId: null }, now).length, 2);
    assert.equal(missingRequirements({ ...eligible, bannedUntil: '2026-10-17T13:00:00Z' }, now).length, 1);
    assert.equal(missingRequirements({ ...eligible, bannedUntil: '2026-10-17T11:00:00Z' }, now).length, 0);
    assert.equal(missingRequirements({ ...eligible, teamLeftAt: '2026-10-16T13:00:00Z' }, now).length, 1);
    assert.equal(missingRequirements({ ...eligible, teamLeftAt: '2026-10-16T11:00:00Z' }, now).length, 0);
    assert.equal(missingRequirements({ ...eligible, inTeam: true }, now).length, 1);
  });

  it('droits : Leaders et couronne', () => {
    const owner = { role: 'leader' as const, isOwner: true };
    const leader = { role: 'leader' as const, isOwner: false };
    const player = { role: 'player' as const, isOwner: false };
    assert.ok(canDo(leader, 'invite') && canDo(leader, 'setStarter') && !canDo(player, 'invite'));
    assert.ok(canDo(leader, 'kick', player) && !canDo(leader, 'kick', leader) && canDo(owner, 'kick', leader));
    assert.ok(!canDo(owner, 'kick', owner) && !canDo(leader, 'kick', owner));
    assert.ok(canDo(owner, 'setRole', player) && !canDo(leader, 'setRole', player));
    for (const action of ['rename', 'transfer', 'disband'] as const) assert.ok(canDo(owner, action) && !canDo(leader, action), action);
    assert.ok(!canDo(null, 'invite'));
  });

  it('images : seulement le dossier du joueur dans team-media', () => {
    const base = 'https://abc.supabase.co';
    assert.ok(isOwnTeamMedia(`${base}/storage/v1/object/public/team-media/u1/logo-123.webp`, base, 'u1'));
    assert.ok(!isOwnTeamMedia(`${base}/storage/v1/object/public/team-media/u2/logo.webp`, base, 'u1'));
    assert.ok(!isOwnTeamMedia(`${base}/storage/v1/object/public/team-media/u1/../x.webp`, base, 'u1'));
    assert.ok(!isOwnTeamMedia('https://evil.com/logo.png', base, 'u1'));
  });
});
