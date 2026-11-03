import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANNELS_PER_CALL, chunkChannels, pickStreams } from './twitchPolicy.js';

const player = (twitch: string) => ({ id: `id-${twitch}`, username: twitch.toUpperCase(), avatarUrl: null, twitch });

describe('Twitch : directs affichés', () => {
  it('garde Call of Duty et GTA, écarte les autres jeux', () => {
    const streams = [
      { user_login: 'alpha', game_name: 'Call of Duty: Modern Warfare 4', type: 'live', viewer_count: 3 },
      { user_login: 'bravo', game_name: 'Grand Theft Auto VI', type: 'live', viewer_count: 9 },
      { user_login: 'charlie', game_name: 'Minecraft', type: 'live', viewer_count: 50 },
    ];
    assert.deepEqual(
      pickStreams(streams, [player('alpha'), player('bravo'), player('charlie')]).map((s) => s.channel),
      ['bravo', 'alpha'],
    );
  });

  it('ignore la casse de la chaîne et les chaînes inconnues', () => {
    const streams = [
      { user_login: 'alpha', game_name: 'Call of Duty', type: 'live' },
      { user_login: 'inconnu', game_name: 'Call of Duty', type: 'live' },
    ];
    const [first, ...others] = pickStreams(streams, [player('AlPhA')]);
    assert.equal(first?.player.id, 'id-AlPhA');
    assert.equal(others.length, 0);
  });

  it('écarte les rediffusions et donne la taille de la miniature', () => {
    const streams = [
      { user_login: 'alpha', game_name: 'Call of Duty', type: 'rerun' },
      { user_login: 'bravo', game_name: 'Call of Duty', type: 'live', thumbnail_url: 'https://x/live_bravo-{width}x{height}.jpg' },
    ];
    const picked = pickStreams(streams, [player('alpha'), player('bravo')]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0]?.thumbnail, 'https://x/live_bravo-640x360.jpg');
  });
});

describe('Twitch : paquets de chaînes', () => {
  it('retire les doublons et respecte la limite par appel', () => {
    assert.deepEqual(chunkChannels(['Alpha', 'alpha', 'bravo']), [['alpha', 'bravo']]);
    const many = Array.from({ length: CHANNELS_PER_CALL + 1 }, (_, i) => `chaine${i}`);
    assert.deepEqual(chunkChannels(many).map((chunk) => chunk.length), [CHANNELS_PER_CALL, 1]);
  });
});
