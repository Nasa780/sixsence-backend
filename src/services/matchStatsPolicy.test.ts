import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureReminderWindow, coversMatch, parseRows, summarizeStats, validRow } from './matchStatsPolicy.js';

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

describe('stats de capture : capture du bon match', () => {
  const sides: [string[], string[]] = [['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']];
  const rows = (...ids: string[]) => ids.map((userId) => ({ userId }));

  it('accepte quand la moitié de chaque équipe est reconnue', () => {
    assert.equal(coversMatch(rows('a', 'b', 'e', 'f'), sides), true);
    assert.equal(coversMatch(rows('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), sides), true);
  });

  it('refuse une capture sans l’équipe adverse ou trop incomplète', () => {
    assert.equal(coversMatch(rows('a', 'b', 'c', 'd'), sides), false);
    assert.equal(coversMatch(rows('a', 'e', 'f', 'g'), sides), false);
  });

  it('en 1v1, il faut les deux joueurs', () => {
    assert.equal(coversMatch(rows('a', 'e'), [['a'], ['e']]), true);
    assert.equal(coversMatch(rows('a'), [['a'], ['e']]), false);
  });
});

describe('stats de capture : rappel', () => {
  it('vise les matchs terminés depuis 10 minutes à 1 heure', () => {
    const now = Date.UTC(2026, 10, 5, 12);
    assert.deepEqual(captureReminderWindow(now), { from: '2026-11-05T11:00:00.000Z', to: '2026-11-05T11:50:00.000Z' });
  });
});
