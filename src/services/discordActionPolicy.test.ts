import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defiActionId, parseDefiAction, reminderDue } from './discordActionPolicy.js';

const ID = '12345678-1234-1234-1234-123456789012';

describe('/defi : menu des joueurs', () => {
  it('relit l’équipe et le type de défi', () => {
    assert.deepEqual(parseDefiAction(defiActionId(ID, true)), { teamId: ID, friendly: true });
    assert.deepEqual(parseDefiAction(defiActionId(ID, false)), { teamId: ID, friendly: false });
  });

  it('refuse les autres identifiants', () => {
    assert.equal(parseDefiAction(`ready:${ID}`), null);
    assert.equal(parseDefiAction(`defi:${ID}:x`), null);
    assert.equal(parseDefiAction(undefined), null);
  });
});

describe('/rappel : moment du message', () => {
  const now = Date.UTC(2026, 10, 7, 18);
  const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

  it('part 2 h avant le début', () => {
    assert.equal(reminderDue(inHours(3), now), false);
    assert.equal(reminderDue(inHours(2), now), true);
    assert.equal(reminderDue(inHours(0.5), now), true);
  });

  it('ne part plus une fois la coupe commencée', () => {
    assert.equal(reminderDue(inHours(-0.1), now), false);
  });
});
