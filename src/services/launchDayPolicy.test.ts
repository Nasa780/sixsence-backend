import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inLaunchDay, LAUNCH_BADGE, withLaunchBadge } from './launchDayPolicy.js';

const at = (iso: string) => Date.parse(iso);

describe('jour 1 de GTA 6', () => {
  it('48 h à partir du 19 novembre minuit, heure de Paris', () => {
    assert.equal(inLaunchDay(at('2026-11-18T23:59:59+01:00')), false);
    assert.equal(inLaunchDay(at('2026-11-19T00:00:00+01:00')), true);
    assert.equal(inLaunchDay(at('2026-11-20T23:59:59+01:00')), true);
    assert.equal(inLaunchDay(at('2026-11-21T00:00:00+01:00')), false);
  });

  it('badge ajouté une seule fois', () => {
    assert.deepEqual(withLaunchBadge(['founder']), ['founder', LAUNCH_BADGE]);
    assert.deepEqual(withLaunchBadge(null), [LAUNCH_BADGE]);
    assert.equal(withLaunchBadge(['founder', LAUNCH_BADGE]), null);
  });
});
