import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queueLevel, shouldAnnounce } from './announcePolicy.js';

describe('annonces de file', () => {
  it('paliers 5v5 : rien, moitié, plus qu’une place', () => {
    assert.equal(queueLevel(0, 10), 0);
    assert.equal(queueLevel(4, 10), 0);
    assert.equal(queueLevel(5, 10), 1);
    assert.equal(queueLevel(8, 10), 1);
    assert.equal(queueLevel(9, 10), 2);
    assert.equal(queueLevel(10, 10), 0); // match lancé : plus rien à annoncer
  });

  it('paliers 2v2', () => {
    assert.equal(queueLevel(1, 4), 0);
    assert.equal(queueLevel(2, 4), 1);
    assert.equal(queueLevel(3, 4), 2);
  });

  it("n'annonce qu'en montant, avec 10 min d'écart", () => {
    const state = new Map<string, { level: number; at: number }>();
    const t = 1_000_000_000;
    assert.equal(shouldAnnounce(state, '5v5', 1, t), true);
    assert.equal(shouldAnnounce(state, '5v5', 1, t + 1000), false); // même palier
    assert.equal(shouldAnnounce(state, '5v5', 2, t + 60_000), false); // trop tôt
    assert.equal(shouldAnnounce(state, '5v5', 2, t + 11 * 60_000), true);
    assert.equal(shouldAnnounce(state, '5v5', 0, t + 12 * 60_000), false); // la file se vide
    assert.equal(shouldAnnounce(state, '5v5', 1, t + 13 * 60_000), false); // moins de 10 min après la dernière
    assert.equal(shouldAnnounce(state, '5v5', 1, t + 22 * 60_000), true);
    assert.equal(shouldAnnounce(state, '2v2', 1, t + 22 * 60_000), true); // chaque file a son propre rythme
  });
});
