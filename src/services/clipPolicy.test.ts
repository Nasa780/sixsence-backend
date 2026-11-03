import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanTitle, parseClipUrl } from './clipPolicy.js';

describe('clips : lecture des liens', () => {
  it('YouTube : vidéo, court lien, Shorts', () => {
    assert.deepEqual(parseClipUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s')?.videoId, 'dQw4w9WgXcQ');
    assert.deepEqual(parseClipUrl('https://youtu.be/dQw4w9WgXcQ')?.provider, 'youtube');
    assert.equal(parseClipUrl('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share')?.videoId, 'dQw4w9WgXcQ');
  });

  it('Twitch : clips.twitch.tv et lien de chaîne', () => {
    assert.equal(parseClipUrl('https://clips.twitch.tv/BraveTenderOxPJSalt-abc123')?.videoId, 'BraveTenderOxPJSalt-abc123');
    assert.equal(parseClipUrl('https://www.twitch.tv/sixsence/clip/FunnyClip-xyz')?.provider, 'twitch');
  });

  it('Medal et TikTok', () => {
    assert.equal(parseClipUrl('https://medal.tv/games/call-of-duty/clips/jT8aB3cD1/ab12cd')?.videoId, 'jT8aB3cD1');
    assert.equal(parseClipUrl('https://medal.tv/clips/jT8aB3cD1')?.provider, 'medal');
    assert.equal(parseClipUrl('https://www.tiktok.com/@nqsq/video/7301234567890123456')?.videoId, '7301234567890123456');
  });

  it('refuse le reste', () => {
    assert.equal(parseClipUrl('https://example.com/video/123'), null);
    assert.equal(parseClipUrl('youtube.com/watch?v=dQw4w9WgXcQ'), null);
    assert.equal(parseClipUrl('https://www.twitch.tv/sixsence'), null);
  });

  it('titre : espaces nettoyés, 1 à 80 caractères', () => {
    assert.equal(cleanTitle('  Ace   sur Lotus  '), 'Ace sur Lotus');
    assert.equal(cleanTitle('   '), null);
    assert.equal(cleanTitle('x'.repeat(81)), null);
  });
});
