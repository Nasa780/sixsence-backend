import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mustConfirmClassic, mustConfirmTeam } from './pendingPolicy.js';

describe('pastilles : match classé à confirmer', () => {
  const match = { team_a: ['a1', 'a2'], team_b: ['b1', 'b2'], reported_by: 'b1' };
  it('l’équipe adverse doit confirmer', () => assert.equal(mustConfirmClassic(match, 'a2'), true));
  it('pas l’équipe qui a déclaré', () => assert.equal(mustConfirmClassic(match, 'b2'), false));
  it('pas sans déclaration', () => assert.equal(mustConfirmClassic({ ...match, reported_by: null }, 'a1'), false));
  it('pas un joueur hors du match', () => assert.equal(mustConfirmClassic(match, 'x'), false));
});

describe('pastilles : match d’équipe à confirmer', () => {
  const match = { team_a: 'A', team_b: 'B', roster_a: ['a1'], roster_b: ['b1'], reported_team: 'A' as const };
  it('un joueur adverse du match', () => assert.equal(mustConfirmTeam(match, 'b1', 'B', false), true));
  it('un Leader adverse hors du match', () => assert.equal(mustConfirmTeam(match, 'b9', 'B', true), true));
  it('pas un joueur adverse hors du match', () => assert.equal(mustConfirmTeam(match, 'b9', 'B', false), false));
  it('pas l’équipe qui a déclaré', () => assert.equal(mustConfirmTeam(match, 'a1', 'A', true), false));
});
