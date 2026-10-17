import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { declarationError, isValidMapScore, map3Picker, pickMaps, seriesState, stakes } from './teamMatchPolicy.js';

describe('matchs d’équipe (BO3)', () => {
  it('score d’une map : 6 manches gagnantes', () => {
    assert.ok(isValidMapScore([6, 4]) && isValidMapScore([0, 6]) && isValidMapScore([6, 5]));
    for (const score of [[6, 6], [5, 4], [7, 2], [6, -1], [6, 2.5], [6], 'x']) assert.ok(!isValidMapScore(score), JSON.stringify(score));
  });

  it('déroulé : maps 1 et 2, puis map 3 à 1-1', () => {
    assert.deepEqual(seriesState([]), { mapsA: 0, mapsB: 0, winner: null, phase: 'maps12', expected: 2 });
    assert.equal(seriesState([[6, 4], [6, 2]]).winner, 'A');
    assert.deepEqual(seriesState([[6, 4], [3, 6]]), { mapsA: 1, mapsB: 1, winner: null, phase: 'map3', expected: 1 });
    assert.equal(seriesState([[6, 4], [3, 6], [2, 6]]).winner, 'B');
  });

  it('map 3 : choisie par l’équipe qui a gagné le plus de manches, égalité = tirage au sort', () => {
    assert.equal(map3Picker([[6, 4], [3, 6]]), 'B'); // 9 contre 10
    assert.equal(map3Picker([[6, 0], [5, 6]]), 'A'); // 11 contre 6
    assert.equal(map3Picker([[6, 4], [4, 6]]), 'random'); // 10 partout
  });

  it('déclaration : bon nombre de maps, scores valides', () => {
    assert.equal(declarationError([], [[6, 4], [3, 6]]), null);
    assert.ok(declarationError([], [[6, 4]]));
    assert.ok(declarationError([], [[6, 4], [6, 6]]));
    assert.equal(declarationError([[6, 4], [3, 6]], [[6, 1]]), null);
    assert.ok(declarationError([[6, 4], [6, 1]], [[6, 1]]));
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
