import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureReminderText, coversMatch, cupBest, maxRounds, objectiveLeader, openMaps, parseRows, plausibleRows, sameCapture, statsBoard, statsByMatch, summarizeStats, validRow } from './matchStatsPolicy.js';

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
    assert.equal(captureReminderText([1], 1), 'Ajoute ta capture pour tes stats');
    assert.equal(captureReminderText([2], 3), 'Il manque la capture de la map 2 pour tes stats');
    assert.equal(captureReminderText([1, 3], 3), 'Il manque la capture des maps 1 et 3 pour tes stats');
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

describe('stats de capture : record des objectifs', () => {
  const maps = (id: string, count: number, plants: number, defuses: number) => Array.from({ length: count }, () => ({ user_id: id, plants, defuses }));

  it('écarte les joueurs sous le minimum de maps', () => {
    assert.equal(objectiveLeader(maps('a', 9, 5, 5)), null);
  });

  it('combine poses et désamorçages en moyenne par map', () => {
    assert.deepEqual(objectiveLeader([...maps('a', 10, 1, 1), ...maps('b', 10, 3, 0), ...maps('c', 12, 0, 0)]), { userId: 'b', value: 3, maps: 10 });
  });

  it('à égalité, garde le joueur qui a le plus de maps', () => {
    assert.equal(objectiveLeader([...maps('a', 10, 1, 0), ...maps('b', 14, 1, 0)])?.userId, 'b');
  });
});

describe('stats de capture : coupes et classements', () => {
  const line = (id: string, score: number, kills: number, plants = 0, defuses = 0) => ({ user_id: id, score, kills, plants, defuses });

  it('désigne le meilleur score cumulé d’une coupe', () => {
    assert.deepEqual(cupBest([line('a', 1000, 5), line('a', 1200, 6), line('b', 2000, 20)]), { userId: 'a', maps: 2, score: 2200, kills: 11, plants: 0, defuses: 0 });
    assert.equal(cupBest([]), null);
  });

  it('départage une égalité de score par les élim.', () => {
    assert.equal(cupBest([line('a', 1000, 5), line('b', 1000, 9)])?.userId, 'b');
  });

  it('calcule les moyennes des joueurs assez présents', () => {
    const rows = [line('a', 1000, 5, 1, 0), line('a', 2000, 10, 1, 1), line('b', 9000, 30)];
    assert.deepEqual(statsBoard(rows, 2), [{ userId: 'a', maps: 2, score: 3000, kills: 15, plants: 2, defuses: 1, avgKills: 7.5, avgScore: 1500, avgObjectives: 1.5 }]);
  });
});
