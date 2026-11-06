import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resultCardUrl, signedPoints, withBestPlayer, withRoundScore } from './resultCardPolicy.js';

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

describe('carte de résultat : nouveautés', () => {
  const classe = resultCardUrl('https://s.fr', { kind: 'classe', label: 'Classé 4v4', a: 'Équipe 1', b: 'Équipe 2', winner: 'B' });

  it('signe les points d’une équipe', () => {
    assert.equal(signedPoints(25), '+25');
    assert.equal(signedPoints(-25), '-25');
  });

  it('écrit les points, les logos et le tour', () => {
    const query = new URL(resultCardUrl('https://s.fr', { kind: 'tournoi', label: 'Coupe', phase: 'Finale', a: 'A', b: 'B', winner: 'A', pointsA: '+25', pointsB: '-25', logoA: 'https://x/a.png' })).searchParams;
    assert.equal(query.get('ph'), 'Finale');
    assert.equal(query.get('ga'), '+25');
    assert.equal(query.get('gb'), '-25');
    assert.equal(query.get('la'), 'https://x/a.png');
    assert.equal(query.has('lb'), false);
  });

  it('met le plus haut score de manches du côté du vainqueur', () => {
    assert.equal(new URL(withRoundScore(classe, [8, 5])).searchParams.get('s'), '5-8');
    assert.equal(new URL(withRoundScore(withRoundScore(classe, [8, 5]), null)).searchParams.has('s'), false);
  });

  it('ajoute les poses, les désamorçages et l’avatar du meilleur joueur', () => {
    const query = new URL(withBestPlayer(classe, { username: 'Viper', score: 3120, kills: 14, plants: 3, defuses: 1, avatarUrl: 'https://x/a.png' })).searchParams;
    assert.equal(query.get('bp'), '3');
    assert.equal(query.get('bd'), '1');
    assert.equal(query.get('ba'), 'https://x/a.png');
    assert.equal(new URL(withBestPlayer(query.size ? `https://s.fr/?${query}` : classe, null)).searchParams.has('ba'), false);
  });
});
