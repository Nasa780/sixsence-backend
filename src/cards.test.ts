import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CARD, MVP_MONTH_CARD, STATIC_CARDS, canEquip, eligibleKeys, longestStreak, mvpOf, revokedKeys, seasonCards, seasonPeak, type CardStats } from './cards.js';

const base: CardStats = {
  peak: 0,
  wins: 0,
  played: 0,
  bestStreak: 0,
  formatsWon: [],
  groupWins: 0,
  soloWins: 0,
  mvpMatches: 0,
  mvpMonths: [],
  seasons: [],
  currentSeason: { id: 1, peak: 0 },
  badges: [],
  team: false,
  referee: false,
  gtaEvents: 0,
};
const stats = (patch: Partial<CardStats>): CardStats => ({ ...base, ...patch });

describe('cartes de visite', () => {
  it('catalogue : 27 cartes permanentes (case MVP du mois comprise) + 3 par saison = 30', () => {
    assert.equal(STATIC_CARDS.length, 27);
    assert.equal(STATIC_CARDS.length + seasonCards(1).length, 30);
    assert.ok(STATIC_CARDS.some((card) => card.key === MVP_MONTH_CARD));
    assert.equal(new Set(STATIC_CARDS.map((card) => card.key)).size, STATIC_CARDS.length);
  });

  it('nouveau joueur : seulement la carte par défaut', () => {
    assert.deepEqual(eligibleKeys(base), [DEFAULT_CARD]);
  });

  it('rangs selon le pic de la saison 1, succès selon la carrière', () => {
    const keys = eligibleKeys(stats({ peak: 1340, currentSeason: { id: 1, peak: 1340 }, wins: 63, played: 80, bestStreak: 6, formatsWon: ['2v2', '3v3', '5v5'], groupWins: 30, soloWins: 14 }));
    for (const key of ['rang-argent', 'rang-or', 'rang-platine', 'rang-diamant', 'premier-sang', 'domination', 'veteran', 'indestructible', 'esprit-equipe']) {
      assert.ok(keys.includes(key), key);
    }
    for (const key of ['rang-maitre', 'centurion', 'invaincu', 'loup-solitaire', 'polyvalent']) assert.ok(!keys.includes(key), key);
  });

  it('Polyvalent ignore la file 1v1 de test', () => {
    assert.ok(!eligibleKeys(stats({ formatsWon: ['1v1', '2v2', '3v3', '4v4'] })).includes('polyvalent'));
    assert.ok(eligibleKeys(stats({ formatsWon: ['2v2', '3v3', '4v4', '5v5'] })).includes('polyvalent'));
  });

  it('progression bornée à l’objectif', () => {
    const centurion = STATIC_CARDS.find((card) => card.key === 'centurion')!;
    assert.deepEqual(centurion.progress!(stats({ wins: 63 })), [63, 100]);
    assert.deepEqual(centurion.progress!(stats({ wins: 140 })), [100, 100]);
  });

  it('cartes de saison : participant (10 matchs), top 10, champion', () => {
    const keys = eligibleKeys(stats({ seasons: [{ id: 1, position: 1, played: 30, peak: 2400 }, { id: 2, position: 14, played: 9, peak: 700 }] }));
    assert.ok(keys.includes('s1-participant') && keys.includes('s1-top10') && keys.includes('s1-champion'));
    assert.ok(!keys.includes('s2-participant') && !keys.includes('s2-top10'));
  });

  it('cartes de rang exclusives : seulement pendant la saison 1, obtenues pour de bon', () => {
    // Saison 1 archivée (Diamant atteint), saison 2 en cours à 2400 : aucune carte au-delà de Diamant.
    const later = stats({ peak: 2400, seasons: [{ id: 1, position: 3, played: 40, peak: 1350 }], currentSeason: { id: 2, peak: 2400 } });
    const keys = eligibleKeys(later);
    assert.ok(keys.includes('rang-diamant'));
    for (const key of ['rang-maitre', 'rang-champion']) assert.ok(!keys.includes(key), key);
    assert.equal(seasonPeak(later, 1), 1350);
    assert.equal(seasonPeak(later, 2), 2400);
    assert.ok(!keys.some((key) => /^sd+-rang-/.test(key)));
    assert.ok(STATIC_CARDS.filter((card) => card.key.startsWith('rang-')).every((card) => card.exclusive));
    // Une carte déjà obtenue ne se retire pas.
    assert.deepEqual(revokedKeys(['rang-legende'], later), []);
  });

  it('communauté, MVP et GTA', () => {
    const keys = eligibleKeys(stats({ badges: ['founder', 'beta', 'partner'], team: true, mvpMonths: ['2026-10'], mvpMatches: 10, gtaEvents: 5 }));
    for (const key of ['fondateur', 'beta', 'partenaire', 'staff-6', MVP_MONTH_CARD, 'mvp-10', 'premiere-viree', 'habitue']) assert.ok(keys.includes(key), key);
  });

  it('Partenaire et Staff sont retirées avec le statut, pas les autres', () => {
    assert.deepEqual(revokedKeys(['partenaire', 'staff-6', 'fondateur', 'rang-or'], stats({ peak: 0 })), ['partenaire', 'staff-6']);
    assert.deepEqual(revokedKeys(['partenaire'], stats({ badges: ['partner'] })), []);
  });

  it('équiper : carte obtenue ou carte par défaut', () => {
    assert.equal(canEquip(DEFAULT_CARD, []), true);
    assert.equal(canEquip('rang-or', ['rang-or']), true);
    assert.equal(canEquip('rang-legende', ['rang-or']), false);
  });

  it('meilleure série et MVP (égalité départagée par les votes des autres)', () => {
    assert.equal(longestStreak([true, true, false, true, true, true, false]), 3);
    assert.deepEqual(mvpOf([]), []);
    assert.deepEqual(
      mvpOf([
        { voter_id: 'a', target_id: 'a' },
        { voter_id: 'b', target_id: 'b' },
        { voter_id: 'c', target_id: 'b' },
        { voter_id: 'd', target_id: 'a' },
      ]),
      ['a', 'b'],
    );
    assert.deepEqual(
      mvpOf([
        { voter_id: 'a', target_id: 'a' },
        { voter_id: 'c', target_id: 'b' },
      ]),
      ['b'],
    );
  });
});
