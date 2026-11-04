import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePeriod, summarize } from './activityPolicy.js';

const row = (day: number, visitors = 0, ranked = 0, division = 0) => ({ day: `2026-11-${String(day).padStart(2, '0')}`, visitors, signups: 0, ranked, division });

describe('Tableau de bord : période', () => {
  it('accepte 7 et 30, 30 sinon', () => {
    assert.equal(parsePeriod('7'), 7);
    assert.equal(parsePeriod(30), 30);
    assert.equal(parsePeriod('999'), 30);
    assert.equal(parsePeriod(undefined), 30);
  });
});

describe('Tableau de bord : comparaison', () => {
  it('sépare la période de la précédente et additionne Classé et Division', () => {
    const { days, trends } = summarize([row(1, 5, 1, 0), row(2, 7, 0, 2), row(3, 2, 1, 1), row(4, 1, 0, 3)], 2);
    assert.deepEqual(days.map((d) => d.day), ['2026-11-03', '2026-11-04']);
    assert.deepEqual(trends.visitors, { current: 3, previous: 12 });
    assert.deepEqual(trends.matches, { current: 5, previous: 3 });
  });

  it('période précédente vide si les jours manquent', () => {
    const { trends } = summarize([row(1, 4)], 7);
    assert.deepEqual(trends.visitors, { current: 4, previous: 0 });
  });
});
