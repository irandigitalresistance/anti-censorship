import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BalePeerType,
  MockBalBus,
  MockSidecar,
  PSK_SALT_INFO,
  buildMeetOffer,
  deriveKeyFromPassword,
  type StartCallResult,
} from '@webtunnel/shared';
import { BaleServerDispatcher } from '../src/bale-session/server-dispatcher.js';
import { TunnelManager } from '../src/dashboard/manager.js';

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

  it('waits for incoming-call push before using a Meet offer fallback', async () => {
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

  it('restarts the incoming-call watcher before Meet offer fallback accept', async () => {
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
