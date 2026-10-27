import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CIRCUIT_POINTS, circuitStandings, finalQualified } from './circuitPolicy.js';

test('points de circuit : podium et équipes présentes', () => {
  const standings = circuitStandings([
    { winner: 'a', finalist: 'b', third: 'c', present: ['a', 'b', 'c', 'd'] },
    { winner: 'b', finalist: 'a', third: null, present: ['a', 'b', 'd'] },
  ]);
  const byId = Object.fromEntries(standings.map((s) => [s.teamId, s]));
  assert.equal(byId.a!.points, CIRCUIT_POINTS.winner + CIRCUIT_POINTS.finalist);
  assert.equal(byId.b!.points, CIRCUIT_POINTS.finalist + CIRCUIT_POINTS.winner);
  assert.equal(byId.c!.points, CIRCUIT_POINTS.third);
  assert.equal(byId.d!.points, CIRCUIT_POINTS.present * 2);
  assert.equal(byId.d!.cups, 2);
});

test('égalité de points : le plus de victoires passe devant', () => {
  const standings = circuitStandings([
    { winner: 'x', finalist: 'y', third: null, present: [] },
    { winner: 'z', finalist: null, third: null, present: ['y'] },
  ]);
  // x : 100 (1 victoire) ; y : 70 + 15 = 85 ; z : 100 (1 victoire).
  assert.deepEqual(
    standings.map((s) => s.teamId),
    ['x', 'z', 'y'],
  );
});

test('grande finale : circuit puis 2 places pour la Division', () => {
  const circuit = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
  const division = [{ id: 'c1' }, { id: 'd1' }, { id: 'c7' }, { id: 'd2' }];
  const active = new Set([...circuit, 'd1', 'd2']);
  const result = finalQualified(circuit, division, 8, active);
  assert.deepEqual(
    result.map((r) => r.teamId),
    ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'd1', 'c7'],
  );
  assert.equal(result.filter((r) => r.via === 'division').length, 2);
});

test('circuit trop court : la Division remplit les places restantes', () => {
  const result = finalQualified(['c1', 'c2'], [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }], 8, new Set(['c1', 'c2', 'd1', 'd2', 'd3']));
  assert.deepEqual(
    result.map((r) => r.teamId),
    ['c1', 'c2', 'd1', 'd2', 'd3'],
  );
});

test('équipe du circuit dissoute : ignorée', () => {
  const result = finalQualified(['gone', 'c1'], [{ id: 'd1' }], 8, new Set(['c1', 'd1']));
  assert.deepEqual(
    result.map((r) => r.teamId),
    ['c1', 'd1'],
  );
});
