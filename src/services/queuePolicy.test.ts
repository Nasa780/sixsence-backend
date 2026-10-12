import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expiresAt, queueTimeouts } from './queuePolicy.js';

const MIN = 60_000;
const rules = { maxMs: 30 * MIN, warnMs: 5 * MIN };
const now = 1_000 * MIN;

describe('durée maximale de recherche', () => {
  it('ne fait rien avant 25 min', () => {
    const result = queueTimeouts([{ groupId: 'a', confirmedAt: now - 24 * MIN, warnedAt: null }], now, rules);
    assert.deepEqual(result, { warn: [], expire: [] });
  });

  it('demande « Toujours là ? » à 25 min, une seule fois', () => {
    assert.deepEqual(queueTimeouts([{ groupId: 'a', confirmedAt: now - 25 * MIN, warnedAt: null }], now, rules), { warn: ['a'], expire: [] });
    assert.deepEqual(queueTimeouts([{ groupId: 'a', confirmedAt: now - 27 * MIN, warnedAt: now - 2 * MIN }], now, rules), {
      warn: [],
      expire: [],
    });
  });

  it('arrête la recherche à 30 min, prévenu ou non', () => {
    const result = queueTimeouts(
      [
        { groupId: 'prevenu', confirmedAt: now - 30 * MIN, warnedAt: now - 5 * MIN },
        { groupId: 'jamais', confirmedAt: now - 45 * MIN, warnedAt: null },
      ],
      now,
      rules,
    );
    assert.deepEqual(result, { warn: [], expire: ['prevenu', 'jamais'] });
  });

  it('« Rester en file » repart pour 30 min', () => {
    // Confirmation à l'instant : compteur remis à zéro, message effacé.
    assert.deepEqual(queueTimeouts([{ groupId: 'a', confirmedAt: now, warnedAt: null }], now, rules), { warn: [], expire: [] });
    assert.equal(expiresAt(now, rules), now + 30 * MIN);
  });
});
