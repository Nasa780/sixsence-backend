import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { avatarChanged, discordAvatarUrl } from './avatarPolicy.js';

describe('avatars Discord', () => {
  it('avatar personnalisé : même adresse que Supabase', () => {
    assert.equal(
      discordAvatarUrl('671440649513336839', '5fe50610e4ef8307e6e205aaa2e8edd3'),
      'https://cdn.discordapp.com/avatars/671440649513336839/5fe50610e4ef8307e6e205aaa2e8edd3.png',
    );
  });

  it('avatar animé en .gif', () => {
    assert.equal(discordAvatarUrl('671440649513336839', 'a_1234'), 'https://cdn.discordapp.com/avatars/671440649513336839/a_1234.gif');
  });

  it('sans avatar : avatar par défaut de Discord', () => {
    const url = discordAvatarUrl('671440649513336839', null);
    assert.match(url, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    assert.equal(discordAvatarUrl('pas-un-nombre', null), 'https://cdn.discordapp.com/embed/avatars/0.png');
  });

  it('réécrit seulement si l’avatar a changé', () => {
    assert.equal(avatarChanged('https://a/1.png', 'https://a/1.png'), false);
    assert.equal(avatarChanged('https://a/1.png', 'https://a/2.png'), true);
    assert.equal(avatarChanged(null, 'https://a/2.png'), true);
  });
});
