import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GRAND_FINAL,
  LOSERS_BASE,
  advanceBracket,
  advanceDouble,
  bestOfDouble,
  bestOfFor,
  bracketSizeFor,
  doubleBracket,
  emptyRounds,
  firstRound,
  podium,
  podiumDouble,
  qualifiedTeams,
  readyEntries,
  roundName,
  roundNameDouble,
  seedOrder,
  shuffle,
} from './tournamentPolicy.js';

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
    assert.deepEqual(podium(bracket, 2), { winner: 't3', finalist: null, third: null });
  });

  it('vainqueurs reportés jusqu’à la finale', () => {
    let bracket = advanceBracket([...firstRound(seeds(4), 4), ...emptyRounds(4)], 2);
    bracket = bracket.map((e) => (e.round === 1 ? { ...e, winner: e.teamA, status: 'done' as const } : e));
    bracket = advanceBracket(bracket, 2);
    const final = bracket.find((e) => e.round === 2)!;
    assert.deepEqual([final.teamA, final.teamB], ['t1', 't2']);
    assert.equal(podium(bracket, 2), null);
    bracket = bracket.map((e) => (e.round === 2 ? { ...e, winner: 't2', status: 'done' as const } : e));
    assert.deepEqual(podium(bracket, 2), { winner: 't2', finalist: 't1', third: null });
  });
});

describe('Coupe Horus', () => {
  const play = (entries: ReturnType<typeof firstRound>, rounds: number, pick: (a: string, b: string) => string) => {
    let current = advanceBracket(entries, rounds);
    for (let guard = 0; guard < 10; guard += 1) {
      const ready = readyEntries(current);
      if (ready.length === 0) break;
      for (const entry of ready) {
        const target = current.find((e) => e.round === entry.round && e.slot === entry.slot)!;
        target.winner = pick(entry.teamA!, entry.teamB!);
        target.status = 'done';
      }
      current = advanceBracket(current, rounds);
    }
    return current;
  };

  it('petite finale : les perdants des demies se disputent le bronze', () => {
    const entries = [...firstRound(seeds(4), 4), ...emptyRounds(4, true)];
    const done = play(entries, 2, (a, b) => (a < b ? a : b));
    assert.deepEqual(podium(done, 2), { winner: 't1', finalist: 't2', third: 't3' });
  });

  it('sans petite finale : pas de 3e', () => {
    const done = play([...firstRound(seeds(4), 4), ...emptyRounds(4)], 2, (a, b) => (a < b ? a : b));
    assert.deepEqual(podium(done, 2), { winner: 't1', finalist: 't2', third: null });
  });

  it('podium en attente tant que la petite finale n’est pas jouée', () => {
    const entries = advanceBracket([...firstRound(seeds(4), 4), ...emptyRounds(4, true)], 2);
    assert.equal(podium(entries, 2), null);
  });

  it('formats : finale à part, petite finale au format des autres matchs', () => {
    const format = { bestOf: 1, finalBestOf: 3 };
    assert.equal(bestOfFor(2, 2, format, 0), 3);
    assert.equal(bestOfFor(2, 2, format, 1), 1);
    assert.equal(bestOfFor(1, 2, format), 1);
  });

  it('taille du tableau selon les inscrits', () => {
    assert.equal(bracketSizeFor(4, 16), 4);
    assert.equal(bracketSizeFor(5, 16), 8);
    assert.equal(bracketSizeFor(9, 8), 8);
    assert.deepEqual([...shuffle(['a', 'b', 'c'], () => 0)].sort(), ['a', 'b', 'c']);
  });
});

describe('Coupe Horus en double élimination', () => {
  // Joue toutes les rencontres prêtes : la meilleure tête de série (numéro le plus petit) gagne.
  const playAll = (entries: ReturnType<typeof doubleBracket>, size: number, pick = (a: string, b: string) => (Number(a.slice(1)) < Number(b.slice(1)) ? a : b)) => {
    let current = advanceDouble(entries, size);
    for (let guard = 0; guard < 40; guard += 1) {
      const ready = readyEntries(current);
      if (ready.length === 0) break;
      for (const entry of ready) {
        const target = current.find((e) => e.round === entry.round && e.slot === entry.slot)!;
        target.winner = pick(entry.teamA!, entry.teamB!);
        target.status = 'done';
      }
      current = advanceDouble(current, size);
    }
    return current;
  };

  it('4 équipes : finale des perdants puis grande finale, bronze au perdant des perdants', () => {
    const done = playAll(doubleBracket(seeds(4), 4), 4);
    assert.equal(done.filter((e) => e.round > LOSERS_BASE && e.round < GRAND_FINAL).length, 2);
    assert.deepEqual(podiumDouble(done, 4), { winner: 't1', finalist: 't2', third: 't3' });
  });

  it('8 équipes : tableau complet, 14 rencontres jouées', () => {
    const done = playAll(doubleBracket(seeds(8), 8), 8);
    assert.equal(done.filter((e) => e.status === 'done').length, 14);
    assert.deepEqual(podiumDouble(done, 8), { winner: 't1', finalist: 't2', third: 't3' });
  });

  it('le vainqueur des perdants peut gagner la grande finale (un seul match)', () => {
    // t2 bat t1 en grande finale après être passé par les perdants.
    let flip = 0;
    const done = playAll(doubleBracket(seeds(4), 4), 4, (a, b) => {
      const both = [a, b].sort().join();
      if (both === 't1,t2') return flip++ === 0 ? 't1' : 't2';
      return Number(a.slice(1)) < Number(b.slice(1)) ? a : b;
    });
    const result = podiumDouble(done, 4)!;
    assert.equal(result.winner, 't2');
    assert.equal(result.finalist, 't1');
  });

  it('5 équipes dans un tableau de 8 : places vides et forfaits résolus jusqu’au podium', () => {
    const done = playAll(doubleBracket(seeds(5), 8), 8);
    const result = podiumDouble(done, 8)!;
    assert.equal(result.winner, 't1');
    assert.ok(result.finalist);
  });

  it('podium en attente tant que la grande finale n’est pas jouée', () => {
    assert.equal(podiumDouble(advanceDouble(doubleBracket(seeds(4), 4), 4), 4), null);
  });

  it('formats et noms', () => {
    assert.equal(bestOfDouble(GRAND_FINAL, { bestOf: 1, finalBestOf: 3 }), 3);
    assert.equal(bestOfDouble(LOSERS_BASE + 1, { bestOf: 1, finalBestOf: 3 }), 1);
    assert.equal(roundNameDouble(GRAND_FINAL, 8), 'Grande finale');
    assert.equal(roundNameDouble(LOSERS_BASE + 4, 8), 'Finale des perdants');
    assert.equal(roundNameDouble(3, 8), 'Finale des gagnants');
  });
});

