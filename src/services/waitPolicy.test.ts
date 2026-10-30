import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { waitedFor } from './waitPolicy.js';

describe("durée d'attente des relances", () => {
  it('affiche la vraie durée, pas un seuil fixe', () => {
    assert.equal(waitedFor(45 * 60_000), '45 min');
    assert.equal(waitedFor(2 * 3600_000 + 5 * 60_000), '2 h 05');
    assert.equal(waitedFor(4 * 3600_000 + 10 * 60_000), '4 h 10');
    assert.equal(waitedFor(27 * 3600_000), '1 j 3 h');
    assert.equal(waitedFor(-1000), '0 min');
  });
});
