import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANNELS_PER_CALL, chunkChannels, liveClaimDay, liveMessage, pickStreams, safeThumbnail, type LiveStream } from './twitchPolicy.js';

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

describe('Twitch : miniatures de clips', () => {
  it('accepte seulement les images de Twitch', () => {
    assert.equal(safeThumbnail('https://clips-media-assets2.twitch.tv/a-preview-480x272.jpg'), 'https://clips-media-assets2.twitch.tv/a-preview-480x272.jpg');
    assert.equal(safeThumbnail('https://static-cdn.jtvnw.net/twitch-clips-thumbnails-prod/a/preview.jpg')?.includes('jtvnw'), true);
    assert.equal(safeThumbnail('https://exemple.com/twitch.tv/a.jpg'), null);
    assert.equal(safeThumbnail('http://clips-media-assets2.twitch.tv/a.jpg'), null);
    assert.equal(safeThumbnail(undefined), null);
  });
});

describe('Twitch : paquets de chaînes', () => {
  it('retire les doublons et respecte la limite par appel', () => {
    assert.deepEqual(chunkChannels(['Alpha', 'alpha', 'bravo']), [['alpha', 'bravo']]);
    const many = Array.from({ length: CHANNELS_PER_CALL + 1 }, (_, i) => `chaine${i}`);
    assert.deepEqual(chunkChannels(many).map((chunk) => chunk.length), [CHANNELS_PER_CALL, 1]);
  });
});

describe('Twitch : annonce Discord', () => {
  const stream: LiveStream = {
    channel: 'alpha',
    title: '@everyone [clique](https://x.fr) *ranked*',
    game: 'Call of Duty',
    viewers: 3,
    startedAt: '2026-11-05T23:30:00Z',
    thumbnail: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_alpha-640x360.jpg',
    player: { id: '1', username: 'Alpha_', avatarUrl: null },
  };

  it('neutralise le titre de Twitch et ne mentionne personne', () => {
    const message = liveMessage(stream);
    assert.equal(message.embeds[0]!.title, '🔴 Alpha est en direct');
    assert.doesNotMatch(message.embeds[0]!.description ?? '', /[@[\]*]/);
    assert.deepEqual(message.allowed_mentions, { parse: [] });
    assert.equal(message.components[0]!.components[0]!.url, 'https://www.twitch.tv/alpha');
  });

  it('écarte une image qui ne vient pas de Twitch', () => {
    assert.equal(liveMessage({ ...stream, thumbnail: 'https://exemple.fr/a.jpg' }).embeds[0]!.image, undefined);
  });

  it('compte le jour de lancement à l’heure de Paris', () => {
    assert.equal(liveClaimDay(stream), '2026-11-06');
  });
});
