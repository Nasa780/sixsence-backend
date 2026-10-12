import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { QueueHub } from './hub.js';

const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const GRACE_MS = 60;
const MOBILE_GRACE_MS = 400;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('délai de grâce de la file (WebSocket)', () => {
  let server: Server;
  let hub: QueueHub;
  let url: string;
  const gone: { userId: string; mobile: boolean; at: number }[] = [];

  before(async () => {
    hub = new QueueHub({
      authenticate: async (token) => ({ id: token }),
      getState: async () => ({}),
      onUserGone: async (userId, { mobile }) => {
        gone.push({ userId, mobile, at: Date.now() });
      },
      isOriginAllowed: () => true,
      graceMs: GRACE_MS,
      mobileGraceMs: MOBILE_GRACE_MS,
    });
    server = createServer();
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  });

  after(() => {
    hub.close();
    server.close();
  });

  /** Ouvre une connexion authentifiée pour le joueur userId et attend « ready ». */
  async function connect(userId: string, userAgent: string): Promise<WebSocket> {
    const socket = new WebSocket(url, { headers: { 'user-agent': userAgent } });
    await new Promise((resolve) => socket.once('open', resolve));
    const ready = new Promise((resolve) => socket.on('message', (raw) => JSON.parse(String(raw)).type === 'ready' && resolve(null)));
    socket.send(JSON.stringify({ type: 'auth', token: userId }));
    await ready;
    return socket;
  }

  async function disconnect(socket: WebSocket): Promise<number> {
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.close();
    await closed;
    return Date.now();
  }

  it('PC : retiré après le délai court', async () => {
    const closedAt = await disconnect(await connect('pc', DESKTOP));
    await wait(GRACE_MS + 150);
    const entry = gone.find((item) => item.userId === 'pc');
    assert.ok(entry, 'le joueur PC doit être retiré');
    assert.equal(entry.mobile, false);
    assert.ok(entry.at - closedAt < MOBILE_GRACE_MS);
  });

  it('téléphone : garde sa place pendant le délai long, puis est retiré', async () => {
    const closedAt = await disconnect(await connect('tel', PHONE));
    await wait(GRACE_MS + 150);
    assert.equal(gone.find((item) => item.userId === 'tel'), undefined, 'pas encore retiré après le délai court');
    await wait(MOBILE_GRACE_MS);
    const entry = gone.find((item) => item.userId === 'tel');
    assert.ok(entry, 'retiré après le délai long');
    assert.equal(entry.mobile, true);
    assert.ok(entry.at - closedAt >= MOBILE_GRACE_MS - 20);
  });

  it('téléphone : revenir avant la fin du délai garde la place', async () => {
    await disconnect(await connect('retour', PHONE));
    await wait(MOBILE_GRACE_MS / 2);
    const socket = await connect('retour', PHONE);
    await wait(MOBILE_GRACE_MS);
    assert.equal(gone.find((item) => item.userId === 'retour'), undefined);
    assert.equal(hub.isConnected('retour'), true);
    await disconnect(socket);
  });
});
