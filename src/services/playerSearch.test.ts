import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchScore, normalizeName, rankPlayers } from './playerSearch.js';

describe('recherche de joueurs', () => {
  it('ramène les pseudos stylisés à des lettres simples', () => {
    assert.equal(normalizeName('𓆩𝑵ø𝒙𝒊ř𝒂シ𓆪'), 'noxira');
    assert.equal(normalizeName('Zейø'), 'zeyo');
    assert.equal(normalizeName('riiiik1 🇺🇸'), 'riiiik1');
    assert.equal(normalizeName('Élodie_Dupré'), 'elodiedupre');
  });

  it('cherche dans le pseudo et l’identifiant Activision', () => {
    const nasa = { username: 'ꪀꪖ𝓼ꪖ', activisionId: 'zNaSa#9589474', points: 416 };
    assert.equal(matchScore(nasa, 'znasa'), 1);
    assert.equal(matchScore(nasa, '9589474'), 2);
    assert.equal(matchScore(nasa, 'lala'), null);
  });

  it('exact, puis début, puis contient ; à égalité, le plus de points', () => {
    const players = [
      { username: 'Lalaland', activisionId: null, points: 900 },
      { username: 'Lala', activisionId: null, points: 100 },
      { username: 'Kalala', activisionId: null, points: 2000 },
      { username: 'Lalo', activisionId: null, points: 50 },
    ];
    assert.deepEqual(rankPlayers(players, 'lala').map((player) => player.username), ['Lala', 'Lalaland', 'Kalala']);
  });

  it('sans recherche : les joueurs du dernier match d’abord, puis le plus de points', () => {
    const players = [
      { username: 'B', activisionId: null, points: 10, lastMatch: 3000 },
      { username: 'A', activisionId: null, points: 300, lastMatch: 1000 },
      { username: 'C', activisionId: null, points: 900, lastMatch: 0 },
      { username: 'D', activisionId: null, points: 50, lastMatch: 0 },
    ];
    assert.deepEqual(rankPlayers(players, '').map((player) => player.username), ['B', 'A', 'C', 'D']);
  });
});
