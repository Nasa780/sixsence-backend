import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAlertThrottle, isNoise, signatureOf } from './alertPolicy.js';

const MIN = 60_000;

describe("alertes d'erreurs", () => {
  it('même erreur avec des identifiants différents : même signature', () => {
    const a = signatureOf('serveur', 'Match 3f2b1c9e-1111-2222-3333-444455556666 introuvable (42)', 'GET /cod/matches/:id');
    const b = signatureOf('serveur', 'Match 9a8b7c6d-aaaa-bbbb-cccc-ddddeeeeffff introuvable (7)', 'GET /cod/matches/:id');
    assert.equal(a, b);
    assert.notEqual(a, signatureOf('site', 'Match x introuvable', 'GET /cod/matches/:id'));
  });

  it('une alerte par erreur toutes les 15 min, répétitions comptées', () => {
    const decide = createAlertThrottle({ repeatMs: 15 * MIN, maxPerHour: 20 });
    assert.deepEqual(decide('e1', 0), { send: true, suppressed: 0 });
    assert.equal(decide('e1', 1 * MIN).send, false);
    assert.equal(decide('e1', 2 * MIN).send, false);
    assert.equal(decide('e2', 3 * MIN).send, true, 'une autre erreur passe');
    assert.deepEqual(decide('e1', 16 * MIN), { send: true, suppressed: 2 });
  });

  it('plafond horaire toutes erreurs confondues', () => {
    const decide = createAlertThrottle({ repeatMs: 15 * MIN, maxPerHour: 3 });
    assert.equal(decide('a', 0).send, true);
    assert.equal(decide('b', 0).send, true);
    assert.equal(decide('c', 0).send, true);
    assert.equal(decide('d', 1).send, false);
    assert.equal(decide('d', 61 * MIN).send, true, 'le plafond se libère après une heure');
  });

  it('ignore le bruit des navigateurs', () => {
    assert.equal(isNoise('ResizeObserver loop completed with undelivered notifications.'), true);
    assert.equal(isNoise('TypeError: Failed to fetch'), true);
    assert.equal(isNoise('Script error.'), true);
    assert.equal(isNoise('ChunkLoadError: Loading chunk 123 failed.'), true);
    assert.equal(isNoise("TypeError: Cannot read properties of undefined (reading 'team_a')"), false);
  });
});
