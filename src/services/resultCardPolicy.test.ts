import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resultCardUrl, withBestPlayer } from './resultCardPolicy.js';

describe('carte de résultat', () => {
  const division = {
    kind: 'division' as const,
    label: 'Division · BO3',
    map: 'Plaza',
    a: '[SIX] SixSence',
    b: '[ABC] Alpha',
    winner: 'A' as const,
    series: [2, 1] as [number, number],
    maps: [{ name: 'Plaza', score: [6, 4] as [number, number] }, { name: 'Mumbai', score: [2, 6] as [number, number] }],
  };

  it('écrit les maps et le score de la série', () => {
    const query = new URL(resultCardUrl('https://s.fr', division)).searchParams;
    assert.equal(query.get('s'), '2-1');
    assert.equal(query.get('m'), 'Plaza:6-4,Mumbai:2-6');
    assert.equal(query.get('a'), '[SIX] SixSence');
  });

  it('ajoute les joueurs en Classé', () => {
    const url = resultCardUrl('https://s.fr', { kind: 'classe', label: 'Classé 4v4', a: 'Équipe 1', b: 'Équipe 2', winner: 'B', playersA: ['Alpha', 'Bravo'] });
    assert.equal(new URL(url).searchParams.get('pa'), 'Alpha · Bravo');
    assert.equal(new URL(url).searchParams.has('pb'), false);
  });

  it('ajoute puis remplace le meilleur joueur sans toucher au reste', () => {
    const url = resultCardUrl('https://s.fr', division);
    const first = withBestPlayer(url, { username: 'Viper', score: 3120, kills: 14 });
    const second = new URL(withBestPlayer(first, { username: 'Kaze', score: 3400, kills: 11 })).searchParams;
    assert.equal(second.get('best'), 'Kaze');
    assert.equal(second.get('bk'), '11');
    assert.equal(second.get('s'), '2-1');
  });

  it('retire le meilleur joueur', () => {
    const url = withBestPlayer(resultCardUrl('https://s.fr', division), { username: 'Viper', score: 3120, kills: 14 });
    assert.equal(new URL(withBestPlayer(url, null)).searchParams.has('best'), false);
  });
});
