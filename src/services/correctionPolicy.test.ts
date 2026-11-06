import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PLAYER_CORRECTION_HOURS, correctionWindowHours, withinWindow, teamArbitrationOpen } from './correctionPolicy.js';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-16T20:00:00Z');
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString();

describe('correction d’un match terminé', () => {
  it('staff et arbitre : 48 h, admin : sans limite', () => {
    assert.equal(correctionWindowHours('staff'), 48);
    assert.equal(correctionWindowHours('arbitre'), 48);
    assert.equal(correctionWindowHours('admin'), null);
  });

  it('dans le délai, puis hors délai', () => {
    assert.ok(withinWindow(ago(47), 48, now));
    assert.ok(!withinWindow(ago(49), 48, now));
    assert.ok(withinWindow(ago(500), null, now));
  });

  it('demande du joueur pendant 24 h', () => {
    assert.ok(withinWindow(ago(23.5), PLAYER_CORRECTION_HOURS, now));
    assert.ok(!withinWindow(ago(25), PLAYER_CORRECTION_HOURS, now));
  });

  it('match sans date de validation : jamais dans un délai limité', () => {
    assert.ok(!withinWindow(null, 48, now));
  });
});

describe('demande d’arbitrage sur un match d’équipe', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  it('reste ouverte pendant le match', () => {
    assert.equal(teamArbitrationOpen('in_progress', null, false, now), true);
    assert.equal(teamArbitrationOpen('forfeit_claimed', null, true, now), true);
  });
  it('devient une correction pendant 24 h', () => {
    assert.equal(teamArbitrationOpen('completed', '2026-11-06T00:00:00Z', false, now), true);
    assert.equal(teamArbitrationOpen('completed', '2026-11-05T00:00:00Z', false, now), false);
  });
  it('ne concerne ni un amical terminé ni un match annulé', () => {
    assert.equal(teamArbitrationOpen('completed', '2026-11-06T00:00:00Z', true, now), false);
    assert.equal(teamArbitrationOpen('cancelled', '2026-11-06T00:00:00Z', false, now), false);
  });
});
