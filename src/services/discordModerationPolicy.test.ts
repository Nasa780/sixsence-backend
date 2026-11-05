import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moderationLine } from './discordModerationPolicy.js';

const entry = { user_id: '1', target_id: '2' };

describe('journal de modération Discord', () => {
  it('décrit les expulsions, bannissements et leur levée, avec le motif', () => {
    assert.equal(moderationLine({ ...entry, action_type: 20 }, 'bot'), '👢 <@1> a expulsé <@2>');
    assert.equal(moderationLine({ ...entry, action_type: 22, reason: 'Spam  *répété*' }, 'bot'), '🔨 <@1> a banni <@2> · Motif : Spam répété');
    assert.match(moderationLine({ ...entry, action_type: 23 }, 'bot') ?? '', /levé le bannissement/);
  });

  it('distingue l’exclusion temporaire de sa levée, et ignore les autres changements', () => {
    const until = '2026-11-05T20:00:00.000Z';
    const line = moderationLine({ ...entry, action_type: 24, changes: [{ key: 'communication_disabled_until', new_value: until }] }, 'bot');
    assert.match(line ?? '', new RegExp(`<t:${new Date(until).getTime() / 1000}:f>`));
    assert.match(moderationLine({ ...entry, action_type: 24, changes: [{ key: 'communication_disabled_until', old_value: until }] }, 'bot') ?? '', /levé l’exclusion/);
    assert.equal(moderationLine({ ...entry, action_type: 24, changes: [{ key: 'nick', new_value: 'x' }] }, 'bot'), null);
  });

  it('compte les messages supprimés et cite le salon', () => {
    assert.equal(moderationLine({ ...entry, action_type: 72, options: { channel_id: '9', count: '1' } }, 'bot'), '🗑️ <@1> a supprimé 1 message de <@2> dans <#9>');
    assert.equal(moderationLine({ user_id: '1', target_id: '9', action_type: 73, options: { count: '12' } }, 'bot'), '🗑️ <@1> a supprimé 12 messages dans <#9>');
  });

  it('ignore le bot, une entrée sans auteur et les autres actions', () => {
    assert.equal(moderationLine({ ...entry, user_id: 'bot', action_type: 22 }, 'bot'), null);
    assert.equal(moderationLine({ ...entry, user_id: null, action_type: 22 }, 'bot'), null);
    assert.equal(moderationLine({ ...entry, action_type: 1 }, 'bot'), null);
  });
});
