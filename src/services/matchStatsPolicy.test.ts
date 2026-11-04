import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRows, summarizeStats, validRow } from './matchStatsPolicy.js';

const row = (userId: string, score = 1570, kills = 10) => ({ userId, score, kills, plants: 1, defuses: 0 });

describe('stats de capture : lignes', () => {
  it('refuse un score qui n’est pas multiple de 5', () => {
    assert.equal(validRow(row('a', 1578)), false);
    assert.equal(validRow(row('a', 1570)), true);
  });

  it('refuse les valeurs négatives ou trop grandes', () => {
    assert.equal(validRow({ ...row('a'), kills: -1 }), false);
    assert.equal(validRow({ ...row('a'), plants: 31 }), false);
    assert.equal(validRow({ ...row('a'), defuses: 1.5 }), false);
  });

  it('accepte seulement les joueurs du match, une fois chacun', () => {
    assert.equal(parseRows([row('a'), row('b')], ['a', 'b', 'c'])?.length, 2);
    assert.equal(parseRows([row('x')], ['a', 'b']), null);
    assert.equal(parseRows([row('a'), row('a')], ['a', 'b']), null);
    assert.equal(parseRows([], ['a']), null);
    assert.equal(parseRows('rien', ['a']), null);
  });
});

describe('stats de capture : bilan', () => {
  it('calcule moyennes, totaux et meilleures valeurs', () => {
    const summary = summarizeStats([
      { score: 1000, kills: 10, plants: 1, defuses: 0 },
      { score: 500, kills: 5, plants: 0, defuses: 2 },
    ]);
    assert.deepEqual(summary, { maps: 2, kills: 15, avgKills: 7.5, avgScore: 750, plants: 1, defuses: 2, bestKills: 10, bestScore: 1000 });
  });

  it('reste à zéro sans map', () => {
    assert.equal(summarizeStats([]).avgKills, 0);
  });
});
