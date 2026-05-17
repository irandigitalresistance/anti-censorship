import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BalePeerType,
  MockBalBus,
  MockSidecar,
  PSK_SALT_INFO,
  TunnelMux,
  buildMeetOffer,
  clientHandshake,
  deriveKeyFromPassword,
  makeChatTransport,
  type StartCallResult,
} from '@webtunnel/shared';
import { BaleServerDispatcher } from '../src/bale-session/server-dispatcher.js';
import { TunnelManager } from '../src/dashboard/manager.js';

function bootTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'X-Path': req.url ?? '' });
      res.end('hello from target\n');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

async function openClient(bus: MockBalBus, myId: number, serverId: number, psk: Uint8Array) {
  const client = new MockSidecar(bus, { id: myId, name: `client-${myId}` });
  const transport = makeChatTransport({ sidecar: client, peer: { chatId: serverId, chatType: 'PRIVATE' } });
  const cipher = await clientHandshake(transport, psk);
  const mux = new TunnelMux({ transport, cipher, role: 'client' });
  return { client, mux };
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return buf;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mockStartCallResult(callId: bigint, peerId: bigint): StartCallResult {
  return {
    callId,
    jwt: 'jwt',
    roomUuid: `room-${callId}`,
    baseUrl: 'wss://meet.example',
    startedAtMs: 0n,
    serverAuthTs: 0n,
    peer: { type: BalePeerType.PRIVATE, id: peerId },
    state: 1,
  };
}

describe('BaleServerDispatcher', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const c of cleanups.splice(0)) await c();
  });

  it('auto-accepts new peers and tunnels HTTP end-to-end', async () => {
    const target = await bootTarget();
    cleanups.push(() => target.close());
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 500, name: 'server' });
    const psk = deriveKeyFromPassword('dispatcher-test-pass', new TextEncoder().encode(PSK_SALT_INFO));
    const manager = new TunnelManager();
    manager.start();
    cleanups.push(() => manager.stop());
    const dispatcher = new BaleServerDispatcher(server, psk, manager);
    dispatcher.start();
    cleanups.push(() => dispatcher.stop());

    const { mux } = await openClient(bus, 600, 500, psk);

    const resp = await new Promise<string>((resolve, reject) => {
      const s = mux.openStream({ kind: 'ipv4', host: '127.0.0.1', port: target.port });
      const chunks: Uint8Array[] = [];
      s.onData((d) => chunks.push(d));
      s.onClose(() => {
        const buf = joinChunks(chunks);
        resolve(new TextDecoder().decode(buf));
      });
      s.write(new TextEncoder().encode('GET /hi HTTP/1.1\r\nHost: target\r\nConnection: close\r\n\r\n'));
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    expect(resp).toContain('HTTP/1.1 200');
    expect(resp).toContain('X-Path: /hi');
    expect(resp).toContain('hello from target');

    expect(manager.snapshot().length).toBe(1);
  }, 10_000);

  it('supports two concurrent clients, each with its own tunnel', async () => {
    const target = await bootTarget();
    cleanups.push(() => target.close());
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 500, name: 'server' });
    const psk = deriveKeyFromPassword('dispatcher-test-pass', new TextEncoder().encode(PSK_SALT_INFO));
    const manager = new TunnelManager();
    manager.start();
    cleanups.push(() => manager.stop());
    const dispatcher = new BaleServerDispatcher(server, psk, manager);
    dispatcher.start();
    cleanups.push(() => dispatcher.stop());

    const [c1, c2] = await Promise.all([openClient(bus, 601, 500, psk), openClient(bus, 602, 500, psk)]);

    async function fetchVia(mux: TunnelMux, route: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const s = mux.openStream({ kind: 'ipv4', host: '127.0.0.1', port: target.port });
        const chunks: Uint8Array[] = [];
        s.onData((d) => chunks.push(d));
        s.onClose(() => resolve(new TextDecoder().decode(joinChunks(chunks))));
        s.write(new TextEncoder().encode(`GET ${route} HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n`));
        setTimeout(() => reject(new Error('timeout')), 3000);
      });
    }

    const [r1, r2] = await Promise.all([fetchVia(c1.mux, '/c1'), fetchVia(c2.mux, '/c2')]);
    expect(r1).toContain('X-Path: /c1');
    expect(r2).toContain('X-Path: /c2');
    expect(manager.snapshot().length).toBe(2);
  }, 10_000);

  it('rejects a client using the wrong PSK', async () => {
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 500, name: 'server' });
    const serverPsk = deriveKeyFromPassword('correct', new TextEncoder().encode(PSK_SALT_INFO));
    const wrongPsk = deriveKeyFromPassword('wrong', new TextEncoder().encode(PSK_SALT_INFO));
    const manager = new TunnelManager();
    manager.start();
    cleanups.push(() => manager.stop());
    const dispatcher = new BaleServerDispatcher(server, serverPsk, manager);
    dispatcher.start();
    cleanups.push(() => dispatcher.stop());

    const client = new MockSidecar(bus, { id: 700, name: 'bad' });
    const transport = makeChatTransport({ sidecar: client, peer: { chatId: 500, chatType: 'PRIVATE' } });
    const racer = Promise.race([
      clientHandshake(transport, wrongPsk).then(() => 'completed').catch((e) => 'rejected:' + e.message),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 300)),
    ]);
    const result = await racer;
    expect(result).toBe('timeout');
    await new Promise((r) => setTimeout(r, 50));
    expect(manager.snapshot().length).toBe(0);
  }, 5000);

  it('waits for incoming-call push before falling back to chat meet-offers', async () => {
    vi.useFakeTimers();
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 500, name: 'server' });
    const client = new MockSidecar(bus, { id: 600, name: 'client' });
    const psk = deriveKeyFromPassword('dispatcher-test-pass', new TextEncoder().encode(PSK_SALT_INFO));
    const manager = new TunnelManager();
    manager.start();
    cleanups.push(() => manager.stop());

    const incomingListeners = new Set<(event: { callId: bigint; roomUuid: string; baseUrl: string; dateMs: number }) => void>();
    const incomingCallSource = {
      onIncomingCall(cb: (event: { callId: bigint; roomUuid: string; baseUrl: string; dateMs: number }) => void) {
        incomingListeners.add(cb);
        return () => incomingListeners.delete(cb);
      },
    };

    const acceptCalls: bigint[] = [];
    const baleClient = {
      receiveCall: async () => undefined,
      acceptCall: async (callId: bigint) => {
        acceptCalls.push(callId);
        return await new Promise<never>(() => undefined);
      },
      discardCall: async () => undefined,
    } as any;

    const dispatcher = new BaleServerDispatcher(server, psk, manager, {
      incomingCallSource: incomingCallSource as any,
      baleClient,
      livekitFactory: async () => {
        throw new Error('should not connect livekit in this test');
      },
    });
    dispatcher.start();
    cleanups.push(() => dispatcher.stop());

    await client.sendMessage({ chatId: 500, chatType: 'PRIVATE' }, buildMeetOffer(123n));
    await Promise.resolve();
    expect(acceptCalls).toEqual([]);

    for (const cb of incomingListeners) {
      cb({ callId: 123n, roomUuid: 'room', baseUrl: 'wss://meet.example', dateMs: Date.now() });
    }
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(acceptCalls).toEqual([123n]);
  });

  it('restarts the incoming-call watcher before chat-offer fallback accept', async () => {
    vi.useFakeTimers();
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 500, name: 'server' });
    const client = new MockSidecar(bus, { id: 601, name: 'client' });
    const psk = deriveKeyFromPassword('dispatcher-test-pass', new TextEncoder().encode(PSK_SALT_INFO));
    const manager = new TunnelManager();
    manager.start();
    cleanups.push(() => manager.stop());

    let restartCalls = 0;
    const acceptCalls: bigint[] = [];
    const baleClient = {
      receiveCall: async () => undefined,
      acceptCall: async (callId: bigint) => {
        acceptCalls.push(callId);
        return await new Promise<never>(() => undefined);
      },
      discardCall: async () => undefined,
    } as any;

    const dispatcher = new BaleServerDispatcher(server, psk, manager, {
      incomingCallSource: { onIncomingCall: () => () => undefined } as any,
      restartIncomingCalls: async () => { restartCalls += 1; },
      baleClient,
      livekitFactory: async () => {
        throw new Error('should not connect livekit in this test');
      },
    });
    dispatcher.start();
    cleanups.push(() => dispatcher.stop());

    await client.sendMessage({ chatId: 500, chatType: 'PRIVATE' }, buildMeetOffer(456n));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(restartCalls).toBe(1);
    expect(acceptCalls).toEqual([456n]);
  });

  it('accepts same-peer meet offers while an earlier call is active', async () => {
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 500, name: 'server' });
    const client = new MockSidecar(bus, { id: 600, name: 'client' });
    const psk = deriveKeyFromPassword('dispatcher-test-pass', new TextEncoder().encode(PSK_SALT_INFO));
    const manager = new TunnelManager();
    manager.start();
    cleanups.push(() => manager.stop());

    const acceptCalls: bigint[] = [];
    const discardCalls: bigint[] = [];
    const baleClient = {
      receiveCall: async () => undefined,
      acceptCall: async (callId: bigint) => {
        acceptCalls.push(callId);
        return await new Promise<never>(() => undefined);
      },
      discardCall: async (callId: bigint) => { discardCalls.push(callId); },
    } as any;

    const dispatcher = new BaleServerDispatcher(server, psk, manager, {
      baleClient,
      livekitFactory: async () => {
        throw new Error('should not connect livekit in this test');
      },
    });
    dispatcher.start();
    cleanups.push(() => dispatcher.stop());

    await client.sendMessage({ chatId: 500, chatType: 'PRIVATE' }, buildMeetOffer(100n));
    await flushAsync();
    expect(acceptCalls).toEqual([100n]);

    await client.sendMessage({ chatId: 500, chatType: 'PRIVATE' }, buildMeetOffer(101n));
    await flushAsync();
    expect(acceptCalls).toEqual([100n, 101n]);
    expect(discardCalls).toEqual([]);
  });

  it('accepts unknown incoming calls even if accept resolves to an already active peer', async () => {
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 500, name: 'server' });
    const psk = deriveKeyFromPassword('dispatcher-test-pass', new TextEncoder().encode(PSK_SALT_INFO));
    const manager = new TunnelManager();
    manager.start();
    cleanups.push(() => manager.stop());

    const incomingListeners = new Set<(event: { callId: bigint; roomUuid: string; baseUrl: string; dateMs: number }) => void>();
    const incomingCallSource = {
      onIncomingCall(cb: (event: { callId: bigint; roomUuid: string; baseUrl: string; dateMs: number }) => void) {
        incomingListeners.add(cb);
        return () => incomingListeners.delete(cb);
      },
    };

    const acceptCalls: bigint[] = [];
    const discardCalls: bigint[] = [];
    const livekitRooms: string[] = [];
    const baleClient = {
      receiveCall: async () => undefined,
      acceptCall: async (callId: bigint) => {
        acceptCalls.push(callId);
        return mockStartCallResult(callId, 600n);
      },
      discardCall: async (callId: bigint) => { discardCalls.push(callId); },
    } as any;

    const dispatcher = new BaleServerDispatcher(server, psk, manager, {
      incomingCallSource: incomingCallSource as any,
      baleClient,
      livekitFactory: async (ctx) => {
        livekitRooms.push(ctx.roomName);
        return await new Promise<never>(() => undefined);
      },
    });
    dispatcher.start();
    cleanups.push(() => dispatcher.stop());

    for (const cb of incomingListeners) {
      cb({ callId: 200n, roomUuid: 'room-200', baseUrl: 'wss://meet.example', dateMs: Date.now() });
    }
    await flushAsync();
    expect(acceptCalls).toEqual([200n]);
    expect(livekitRooms).toEqual(['room-200']);

    for (const cb of incomingListeners) {
      cb({ callId: 201n, roomUuid: 'room-201', baseUrl: 'wss://meet.example', dateMs: Date.now() });
    }
    await flushAsync();
    expect(acceptCalls).toEqual([200n, 201n]);
    expect(livekitRooms).toEqual(['room-200', 'room-201']);
    expect(discardCalls).toEqual([]);
  });
});
