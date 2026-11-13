import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discordAvatarUrl, discordDisplayName, profileChanges } from './discordProfilePolicy.js';

const ID = '671440649513336839';

describe('pseudo et avatar Discord', () => {
  it('avatar personnalisé : même adresse que Supabase', () => {
    assert.equal(discordAvatarUrl(ID, '5fe50610e4ef8307e6e205aaa2e8edd3'), `https://cdn.discordapp.com/avatars/${ID}/5fe50610e4ef8307e6e205aaa2e8edd3.png`);
  });

  it('avatar animé en .gif', () => {
    assert.equal(discordAvatarUrl(ID, 'a_1234'), `https://cdn.discordapp.com/avatars/${ID}/a_1234.gif`);
  });

  it('sans avatar : avatar par défaut de Discord', () => {
    assert.match(discordAvatarUrl(ID, null), /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    assert.equal(discordAvatarUrl('pas-un-nombre', null), 'https://cdn.discordapp.com/embed/avatars/0.png');
  });

  it("pseudo : nom d'affichage, sinon nom d'utilisateur, 40 caractères", () => {
    assert.equal(discordDisplayName({ global_name: ' Nasa ', username: 'nasa780' }), 'Nasa');
    assert.equal(discordDisplayName({ global_name: null, username: 'nasa780' }), 'nasa780');
    assert.equal(discordDisplayName({ global_name: '', username: '' }), 'Joueur');
    assert.equal([...discordDisplayName({ global_name: '𝑵'.repeat(50) })].length, 40);
  });

  it('seuls les champs changés sont réécrits', () => {
    const stored = { username: 'Nasa', avatar_url: `https://cdn.discordapp.com/avatars/${ID}/abc.png` };
    assert.deepEqual(profileChanges(stored, { id: ID, global_name: 'Nasa', username: 'nasa780', avatar: 'abc' }), {});
    assert.deepEqual(profileChanges(stored, { id: ID, global_name: 'Nasa 2', username: 'nasa780', avatar: 'abc' }), { username: 'Nasa 2' });
    assert.deepEqual(profileChanges(stored, { id: ID, global_name: 'Nasa', username: 'nasa780', avatar: 'def' }), { avatar_url: `https://cdn.discordapp.com/avatars/${ID}/def.png` });
  });

  it('événement sans pseudo : pseudo laissé tel quel', () => {
    assert.deepEqual(profileChanges({ username: 'Nasa', avatar_url: null }, { id: ID, avatar: null }), { avatar_url: discordAvatarUrl(ID, null) });
  });
});
