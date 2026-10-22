import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEAGUES_MIN_TEAMS, assignLeagues, type League, type LeagueTeam } from './leaguePolicy.js';

const team = (i: number, league: League | null = null, points = 2000 - i * 10): LeagueTeam => ({ id: `t${i}`, league, points, wins: 0, createdAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` });

describe('ligues de la Division', () => {
  it('pas de ligue sous 16 équipes', () => {
    const result = assignLeagues(Array.from({ length: LEAGUES_MIN_TEAMS - 1 }, (_, i) => team(i)));
    assert.ok([...result.values()].every((league) => league === null));
  });

  it('première répartition selon le classement', () => {
    const result = assignLeagues(Array.from({ length: 20 }, (_, i) => team(i)));
    assert.equal(result.get('t0'), 'elite');
    assert.equal(result.get('t7'), 'elite');
    assert.equal(result.get('t8'), 'ligue1');
    assert.equal(result.get('t15'), 'ligue1');
    assert.equal(result.get('t19'), 'ligue2');
  });

  it('fin de saison : 2 montées et 2 descentes par frontière, nouvelle équipe en Ligue 2', () => {
    const teams = [
      ...Array.from({ length: 8 }, (_, i) => team(i, 'elite', 1500 - i * 10)),
      ...Array.from({ length: 8 }, (_, i) => team(10 + i, 'ligue1', 1400 - i * 10)),
      ...Array.from({ length: 4 }, (_, i) => team(20 + i, 'ligue2', 1300 - i * 10)),
      team(30, null, 5000),
    ];
    const result = assignLeagues(teams);
    assert.equal(result.get('t6'), 'ligue1');
    assert.equal(result.get('t7'), 'ligue1');
    assert.equal(result.get('t10'), 'elite');
    assert.equal(result.get('t11'), 'elite');
    assert.equal(result.get('t16'), 'ligue2');
    assert.equal(result.get('t17'), 'ligue2');
    // t30 (nouvelle, 5000 pts) est comptée en Ligue 2 et monte avec t20.
    assert.equal(result.get('t30'), 'ligue1');
    assert.equal(result.get('t20'), 'ligue1');
    assert.equal(result.get('t21'), 'ligue2');
  });
});
