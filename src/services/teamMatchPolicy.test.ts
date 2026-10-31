import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { declarationError, deciderPicker, isCompleteSeries, isValidMapScore, pickMaps, roundsToWin, seriesState, stakes } from './teamMatchPolicy.js';

describe('matchs d’équipe (BO3 / BO5)', () => {
  it('score d’une map : 6 manches gagnantes', () => {
    assert.ok(isValidMapScore([6, 4]) && isValidMapScore([0, 6]) && isValidMapScore([6, 5]));
    for (const score of [[6, 6], [5, 4], [7, 2], [6, -1], [6, 2.5], [6], 'x']) assert.ok(!isValidMapScore(score), JSON.stringify(score));
  });

  it('BO1 : une map en 8 manches gagnantes', () => {
    assert.equal(roundsToWin(1), 8);
    assert.equal(roundsToWin(3), 6);
    assert.ok(isValidMapScore([8, 7], 8) && !isValidMapScore([6, 4], 8));
    assert.equal(declarationError([], [[8, 5]], 1), null);
    assert.ok(declarationError([], [[6, 4]], 1));
    assert.ok(isCompleteSeries([[3, 8]], 1) && !isCompleteSeries([[6, 3]], 1));
  });

  it('BO3 : maps 1 et 2, puis map décisive à 1-1', () => {
    assert.deepEqual(seriesState([]), { mapsA: 0, mapsB: 0, winner: null, phase: 'first', expected: 2 });
    assert.equal(seriesState([[6, 4], [6, 2]]).winner, 'A');
    assert.deepEqual(seriesState([[6, 4], [3, 6]]), { mapsA: 1, mapsB: 1, winner: null, phase: 'decider', expected: 1 });
    assert.equal(seriesState([[6, 4], [3, 6], [2, 6]]).winner, 'B');
  });

  it('BO5 : maps 1 à 3, puis la 4e, puis la décisive à 2-2', () => {
    assert.equal(seriesState([], 5).expected, 3);
    assert.equal(seriesState([[6, 1], [6, 2], [6, 3]], 5).winner, 'A');
    assert.equal(seriesState([[6, 1], [2, 6], [6, 3]], 5).phase, 'next');
    assert.equal(seriesState([[6, 1], [2, 6], [6, 3], [4, 6]], 5).phase, 'decider');
  });

  it('map décisive : choisie par l’équipe qui a gagné le plus de manches, égalité = tirage au sort', () => {
    assert.equal(deciderPicker([[6, 4], [3, 6]]), 'B'); // 9 contre 10
    assert.equal(deciderPicker([[6, 0], [5, 6]]), 'A'); // 11 contre 6
    assert.equal(deciderPicker([[6, 4], [4, 6]]), 'random'); // 10 partout
  });

  it('déclaration unique : série terminée, scores valides, rien après la victoire', () => {
    assert.equal(declarationError([], [[6, 4], [6, 3]]), null);
    assert.equal(declarationError([], [[6, 4], [3, 6], [6, 1]]), null);
    assert.ok(declarationError([], [[6, 4], [3, 6]])); // 1-1 : il manque la map décisive
    assert.ok(declarationError([], [[6, 4]]));
    assert.ok(declarationError([], [[6, 4], [6, 6]]));
    assert.ok(declarationError([], [[6, 4], [6, 1], [6, 2]])); // déjà gagné à la map 2
    assert.ok(declarationError([], [[6, 4], [3, 6], [6, 1], [6, 0]]));
    assert.equal(declarationError([[6, 4], [3, 6]], [[6, 1]]), null); // ancien match déclaré en deux fois
    assert.ok(declarationError([[6, 4], [6, 1]], [[6, 1]]));
    assert.equal(declarationError([], [[6, 1], [2, 6], [6, 3], [6, 4]], 5), null);
    assert.ok(declarationError([], [[6, 1], [2, 6], [6, 3]], 5));
  });

  it('arbitrage : série complète, vainqueur sur la dernière map', () => {
    assert.ok(isCompleteSeries([[6, 4], [6, 2]]));
    assert.ok(isCompleteSeries([[6, 4], [3, 6], [6, 0]]));
    assert.ok(!isCompleteSeries([[6, 4], [6, 2], [0, 6]]));
    assert.ok(!isCompleteSeries([[6, 4]]));
    assert.ok(isCompleteSeries([[6, 1], [2, 6], [6, 3], [4, 6], [6, 5]], 5));
  });

  it('maps tirées au sort sans doublon ni map déjà jouée', () => {
    const pool = ['Exposure', 'Imprint', 'Den', 'Raid'];
    const two = pickMaps(pool, 2);
    assert.equal(new Set(two).size, 2);
    assert.deepEqual(pickMaps(pool, 1, ['Exposure', 'Imprint', 'Den']), ['Raid']);
  });

  it('enjeux façon Elo : ±25 à égalité, plus contre plus fort, somme nulle', () => {
    assert.deepEqual(stakes(1000, 1000), { A: { win: 25, loss: 25 }, B: { win: 25, loss: 25 } });
    const s = stakes(1284, 1412);
    assert.ok(s.A.win > 25 && s.A.loss < 25);
    assert.equal(s.A.win, s.B.loss);
    assert.equal(s.A.loss, s.B.win);
    assert.deepEqual(stakes(0, 5000).A, { win: 45, loss: 5 });
  });
});
