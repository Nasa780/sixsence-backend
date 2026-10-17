import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advanceBracket, bestOfFor, emptyRounds, firstRound, podium, qualifiedTeams, readyEntries, roundName, seedOrder } from './tournamentPolicy.js';

const seeds = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

describe('tournoi de fin de saison', () => {
  it('têtes de série : 1 et 2 ne se croisent qu’en finale', () => {
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    assert.equal(seedOrder(16).length, 16);
    assert.deepEqual(seedOrder(16).slice(0, 2), [1, 16]);
  });

  it('noms des tours et format', () => {
    assert.equal(roundName(4, 4), 'Finale');
    assert.equal(roundName(1, 4), 'Huitièmes de finale');
    assert.equal(roundName(1, 3), 'Quarts de finale');
    assert.equal(bestOfFor(3, 3), 5);
    assert.equal(bestOfFor(2, 3), 3);
  });

  it('qualifiés : 25 matchs minimum, meilleurs points d’abord', () => {
    const teams = [
      { id: 'a', points: 1400, wins: 20, played: 24, createdAt: '1' },
      { id: 'b', points: 1300, wins: 20, played: 30, createdAt: '1' },
      { id: 'c', points: 1350, wins: 18, played: 25, createdAt: '2' },
    ];
    assert.deepEqual(qualifiedTeams(teams, 8).map((t) => t.id), ['c', 'b']);
  });

  it('6 équipes pour 8 places : les têtes de série 1 et 2 passent le 1er tour', () => {
    let bracket = [...firstRound(seeds(6), 8), ...emptyRounds(8)];
    bracket = advanceBracket(bracket, 3);
    const r1 = bracket.filter((e) => e.round === 1);
    assert.deepEqual(r1[0], { round: 1, slot: 0, teamA: 't1', teamB: null, winner: 't1', status: 'done' });
    assert.equal(readyEntries(bracket).length, 2); // 4 contre 5 et 3 contre 6
    assert.equal(bracket.find((e) => e.round === 2 && e.slot === 0)!.teamA, 't1');
  });

  it('forfait des deux équipes : la rencontre est vide, l’adversaire du tour suivant passe', () => {
    let bracket = [...firstRound(['t1', 't2', 't3', 't4'], 4), ...emptyRounds(4)];
    bracket[0] = { ...bracket[0]!, teamA: null, teamB: null }; // t1 et t4 absents
    bracket = advanceBracket(bracket, 2);
    assert.equal(bracket[0]!.status, 'empty');
    bracket[1] = { ...bracket[1]!, winner: 't3', status: 'done' };
    bracket = advanceBracket(bracket, 2);
    assert.deepEqual(podium(bracket, 2), { winner: 't3', finalist: null });
  });

  it('vainqueurs reportés jusqu’à la finale', () => {
    let bracket = advanceBracket([...firstRound(seeds(4), 4), ...emptyRounds(4)], 2);
    bracket = bracket.map((e) => (e.round === 1 ? { ...e, winner: e.teamA, status: 'done' as const } : e));
    bracket = advanceBracket(bracket, 2);
    const final = bracket.find((e) => e.round === 2)!;
    assert.deepEqual([final.teamA, final.teamB], ['t1', 't2']);
    assert.equal(podium(bracket, 2), null);
    bracket = bracket.map((e) => (e.round === 2 ? { ...e, winner: 't2', status: 'done' as const } : e));
    assert.deepEqual(podium(bracket, 2), { winner: 't2', finalist: 't1' });
  });
});
