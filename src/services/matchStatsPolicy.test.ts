import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureReminderText, captureReminderWindow, coversMatch, maxRounds, openMaps, parseRows, plausibleRows, sameCapture, statsByMatch, summarizeStats, validRow } from './matchStatsPolicy.js';

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

describe('stats de capture : contrôles', () => {
  const sides: [string[], string[]] = [['a', 'b'], ['c', 'd']];

  it('compte les manches possibles', () => {
    assert.equal(maxRounds(8), 15);
    assert.equal(maxRounds(6), 11);
  });

  it('accepte des chiffres possibles', () => {
    assert.equal(plausibleRows([row('a', 1500, 16), row('b', 1500, 14), row('c', 1500, 10)], sides, 8), true);
  });

  it('refuse plus d’éliminations que d’adversaires à tuer', () => {
    assert.equal(plausibleRows([row('a', 1500, 16), row('b', 1500, 15)], sides, 8), false);
  });

  it('refuse plus de poses ou de désamorçages que de manches', () => {
    assert.equal(plausibleRows([{ ...row('a'), plants: 16 }], sides, 8), false);
    assert.equal(plausibleRows([{ ...row('a'), plants: 0, defuses: 12 }], sides, 6), false);
  });

  it('reconnaît une seconde capture de la même map', () => {
    const existing = [row('a', 1500, 10), row('c', 1200, 8)];
    assert.equal(sameCapture(existing, [row('a', 1500, 10), row('b', 900, 4)]), true);
    assert.equal(sameCapture(existing, [row('a', 2000, 3), row('c', 1000, 2), row('b', 900, 4)]), false);
    assert.equal(sameCapture(existing, [row('b', 900, 4)]), false);
  });
});

describe('stats de capture : maps à compléter', () => {
  it('garde les maps sans capture ou incomplètes', () => {
    assert.deepEqual(openMaps(3, [{ map_no: 1 }, { map_no: 1 }, { map_no: 2 }], 2), [2, 3]);
    assert.deepEqual(openMaps(1, [{ map_no: 1 }, { map_no: 1 }], 2), []);
  });

  it('précise la map du rappel quand il y en a plusieurs', () => {
    assert.equal(captureReminderText('u', [1], 1), '📸 Ajoute ta capture pour tes stats : u');
    assert.equal(captureReminderText('u', [2], 3), '📸 Il manque la capture de la map 2 pour tes stats : u');
    assert.equal(captureReminderText('u', [1, 3], 3), '📸 Il manque la capture des maps 1 et 3 pour tes stats : u');
  });
});

describe('stats de capture : historique', () => {
  it('additionne les maps d’un match', () => {
    const line = { score: 100, kills: 5, plants: 1, defuses: 0 };
    assert.deepEqual(statsByMatch([{ ...line, match_id: 'x' }, { ...line, match_id: 'x' }, { ...line, match_id: 'y' }]), {
      x: { score: 200, kills: 10, plants: 2, defuses: 0 },
      y: line,
    });
  });
});
