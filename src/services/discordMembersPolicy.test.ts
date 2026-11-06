import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_CATCH_UP, diffMembers, goodbyeText, plainName, welcomeImageUrl, welcomeText, memberCountName, playerCardUrl } from './discordMembersPolicy.js';

const now = 1_800_000_000_000;
const hour = 3600_000;

describe('arrivées et départs Discord', () => {
  it('annonce les arrivées récentes et les départs', () => {
    const diff = diffMembers([{ id: 'a', present: true }, { id: 'b', present: true }], [{ id: 'a', joinedAt: now - 900 * hour }, { id: 'c', joinedAt: now - hour }], now);
    assert.deepEqual(diff.welcome.map((m) => m.id), ['c']);
    assert.deepEqual(diff.departed, ['b']);
    assert.deepEqual(diff.silent, []);
    assert.equal(diff.suspicious, false);
  });

  it('note sans message une arrivée trop ancienne', () => {
    const diff = diffMembers([{ id: 'a', present: true }], [{ id: 'a', joinedAt: now - 900 * hour }, { id: 'old', joinedAt: now - 48 * hour }], now);
    assert.deepEqual(diff.welcome, []);
    assert.deepEqual(diff.silent.map((m) => m.id), ['old']);
  });

  it('traite un retour comme une arrivée', () => {
    const diff = diffMembers([{ id: 'a', present: false }], [{ id: 'a', joinedAt: now - hour }], now);
    assert.deepEqual(diff.welcome.map((m) => m.id), ['a']);
  });

  it('limite le rattrapage, les plus récents d’abord', () => {
    const current = Array.from({ length: MAX_CATCH_UP + 3 }, (_, i) => ({ id: `n${i}`, joinedAt: now - i * 1000 }));
    const diff = diffMembers([{ id: 'n0', present: false }], current, now);
    assert.equal(diff.welcome.length, MAX_CATCH_UP);
    assert.equal(diff.welcome[0]!.id, 'n0');
    assert.equal(diff.silent.length, 3);
  });

  it('ne touche à rien si la liste paraît incomplète', () => {
    const known = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, present: true }));
    assert.equal(diffMembers(known, [{ id: 'm0', joinedAt: now - 900 * hour }], now).suspicious, true);
    assert.equal(diffMembers([{ id: 'a', present: true }], [], now).suspicious, true);
  });

  it('retire la mise en forme des pseudos', () => {
    assert.equal(plainName('**Nasa**_@everyone'), 'Nasaeveryone');
    assert.equal(plainName('  '), 'Un membre');
    assert.equal(goodbyeText(null), '**Un membre** a quitté SixSence. Bonne continuation, la porte reste ouverte. 👋');
  });

  it('mentionne le membre, sans lien écrit', () => {
    const text = welcomeText('42');
    assert.match(text, /<@42>/);
    assert.doesNotMatch(text, /https?:/);
  });

  it('encode le pseudo dans l’adresse de l’image', () => {
    assert.equal(welcomeImageUrl('https://s.fr', '42', 'abc', 'Le Boss'), 'https://s.fr/api/og/bienvenue?id=42&name=Le+Boss&a=abc');
    assert.equal(welcomeImageUrl('https://s.fr', '42', null, 'x'), 'https://s.fr/api/og/bienvenue?id=42&name=x');
    assert.equal(welcomeImageUrl('https://s.fr', '42', null, 'x', 130), 'https://s.fr/api/og/bienvenue?id=42&name=x&n=130');
  });
});

describe('compteur et carte de joueur', () => {
  it('écrit le nombre de membres dans le nom du salon', () => {
    assert.equal(memberCountName(130), '👥 Membres : 130');
  });

  it('change l’adresse de la carte quand les stats changent', () => {
    const stats = { points: 1200, wins: 5, losses: 2, calling_card: 'sixsence' };
    assert.equal(playerCardUrl('https://s.fr', 'abc', stats), 'https://s.fr/api/og/player?id=abc&v=1200-5-2-sixsence');
    assert.notEqual(playerCardUrl('https://s.fr', 'abc', stats), playerCardUrl('https://s.fr', 'abc', { ...stats, wins: 6 }));
  });

  it('prend la carte de visite par défaut', () => {
    assert.match(playerCardUrl('https://s.fr', 'abc', { points: 0, wins: 0, losses: 0, calling_card: null }), /v=0-0-0-sixsence$/);
  });
});
