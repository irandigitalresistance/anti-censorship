import { describe, expect, it } from 'vitest';
import { SessionCipher } from '../src/handshake.js';
import { TunnelMuxV2 } from '../src/mux-v2.js';
import { decodeV2ControlMessage, decodeV2Packet } from '../src/protocol-v2.js';
import type { Transport } from '../src/transport.js';

type Direction = 'a->b' | 'b->a';

function pair(
  shouldDrop?: (direction: Direction, bytes: Uint8Array) => boolean,
  onUnreliable?: (direction: Direction) => void,
): { a: Transport; b: Transport } {
  let aMsg: ((b: Uint8Array) => void) | null = null;
  let bMsg: ((b: Uint8Array) => void) | null = null;
  let aClose: ((r: string) => void) | null = null;
  let bClose: ((r: string) => void) | null = null;
  const deliver = (direction: Direction, bytes: Uint8Array) => {
    queueMicrotask(() => {
      if (shouldDrop?.(direction, bytes)) return;
      if (direction === 'a->b') bMsg?.(bytes);
      else aMsg?.(bytes);
    });
  };
  return {
    a: {
      send(bytes) {
        deliver('a->b', bytes);
      },
      sendUnreliable(bytes) {
        onUnreliable?.('a->b');
        deliver('a->b', bytes);
      },
      onMessage(cb) {
        aMsg = cb;
      },
      onClose(cb) {
        aClose = cb;
      },
      close(reason = 'a closed') {
        queueMicrotask(() => {
          aClose?.(reason);
          bClose?.(reason);
        });
      },
    },
    b: {
      send(bytes) {
        deliver('b->a', bytes);
      },
      sendUnreliable(bytes) {
        onUnreliable?.('b->a');
        deliver('b->a', bytes);
      },
      onMessage(cb) {
        bMsg = cb;
      },
      onClose(cb) {
        bClose = cb;
      },
      close(reason = 'b closed') {
        queueMicrotask(() => {
          aClose?.(reason);
          bClose?.(reason);
        });
      },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TunnelMuxV2', () => {
  it('round-trips TCP stream payloads', async () => {
    const { a, b } = pair();
    const key = new Uint8Array(32);
    const client = new TunnelMuxV2({ transport: a, cipher: SessionCipher.fromKey(key), role: 'client' });
    const server = new TunnelMuxV2({ transport: b, cipher: SessionCipher.fromKey(key), role: 'server' });

    server.onStream((stream) => {
      stream.onData((data) => {
        const echoed = new Uint8Array(data.byteLength + 1);
        echoed.set(data, 0);
        echoed[echoed.byteLength - 1] = 0x21;
        stream.write(echoed);
      });
    });

    const stream = client.openStream({ kind: 'domain', host: 'example.com', port: 443 });
    const result = new Promise<string>((resolve) => {
      stream.onData((data) => resolve(new TextDecoder().decode(data)));
    });
    stream.write(new TextEncoder().encode('hi'));
    await expect(result).resolves.toBe('hi!');
  });

  it('supports UDP flow relay', async () => {
    const { a, b } = pair();
    const key = new Uint8Array(32);
    const client = new TunnelMuxV2({ transport: a, cipher: SessionCipher.fromKey(key), role: 'client' });
    const server = new TunnelMuxV2({ transport: b, cipher: SessionCipher.fromKey(key), role: 'server' });

    server.onUdpFlow((flow) => {
      flow.onMessage((data) => {
        const echoed = new Uint8Array(data.byteLength + 1);
        echoed.set(data, 0);
        echoed[echoed.byteLength - 1] = 0x01;
        flow.send(echoed);
      });
    });

    const flow = client.openUdpFlow({ kind: 'ipv4', host: '1.1.1.1', port: 53 });
    const out = new Promise<Uint8Array>((resolve) => {
      flow.onMessage((data) => resolve(data));
    });
    flow.send(new Uint8Array([9, 8, 7]));
    await expect(out).resolves.toEqual(new Uint8Array([9, 8, 7, 1]));
  });

  it('keeps the heartbeat alive when data arrives while pong is delayed', async () => {
    const key = new Uint8Array(32);
    const inspector = SessionCipher.fromKey(key);
    const { a, b } = pair((direction, bytes) => {
      if (direction !== 'b->a') return false;
      const packet = decodeV2Packet(inspector.decrypt(bytes));
      if (packet.type !== 'control') return false;
      return decodeV2ControlMessage(packet.payload).kind === 'pong';
    });
    const client = new TunnelMuxV2({
      transport: a,
      cipher: SessionCipher.fromKey(key),
      role: 'client',
      pingIntervalMs: 10,
      maxMissedPongs: 2,
    });
    const server = new TunnelMuxV2({
      transport: b,
      cipher: SessionCipher.fromKey(key),
      role: 'server',
      pingIntervalMs: 10,
      maxMissedPongs: 20,
    });
    let closeReason: string | null = null;
    client.onClose((reason) => { closeReason = reason; });
    server.onStream((stream) => {
      const timer = setInterval(() => stream.write(new Uint8Array([0x42])), 5);
      stream.onClose(() => clearInterval(timer));
    });

    const stream = client.openStream({ kind: 'domain', host: 'example.com', port: 443 });
    await new Promise<void>((resolve) => {
      let received = 0;
      stream.onData(() => {
        received += 1;
        if (received >= 5) resolve();
      });
    });
    await sleep(40);

    expect(closeReason).toBeNull();
    client.close('test complete');
    server.close('test complete');
  });

  it('uses the unreliable transport path for heartbeat packets when available', async () => {
    const key = new Uint8Array(32);
    const unreliableDirections: Direction[] = [];
    const { a, b } = pair(undefined, (direction) => unreliableDirections.push(direction));
    const client = new TunnelMuxV2({
      transport: a,
      cipher: SessionCipher.fromKey(key),
      role: 'client',
      pingIntervalMs: 10,
      maxMissedPongs: 20,
    });
    const server = new TunnelMuxV2({
      transport: b,
      cipher: SessionCipher.fromKey(key),
      role: 'server',
      pingIntervalMs: 10,
      maxMissedPongs: 20,
    });

    await sleep(40);

    expect(unreliableDirections).toContain('a->b');
    expect(unreliableDirections).toContain('b->a');
    client.close('test complete');
    server.close('test complete');
  });

  it('ignores isolated invalid peer packets instead of dropping the tunnel', async () => {
    const { a, b } = pair();
    const key = new Uint8Array(32);
    const client = new TunnelMuxV2({
      transport: a,
      cipher: SessionCipher.fromKey(key),
      role: 'client',
      disableHeartbeat: true,
    });
    const server = new TunnelMuxV2({
      transport: b,
      cipher: SessionCipher.fromKey(key),
      role: 'server',
      disableHeartbeat: true,
    });
    let closeReason: string | null = null;
    client.onClose((reason) => { closeReason = reason; });

    b.send(new Uint8Array([1, 2, 3, 4]));
    await sleep(5);

    server.onStream((stream) => {
      stream.onData((data) => stream.write(data));
    });
    const stream = client.openStream({ kind: 'domain', host: 'example.com', port: 443 });
    const echoed = new Promise<Uint8Array>((resolve) => {
      stream.onData((data) => resolve(data));
    });
    stream.write(new Uint8Array([0x7b]));

    await expect(echoed).resolves.toEqual(new Uint8Array([0x7b]));
    expect(closeReason).toBeNull();
    client.close('test complete');
    server.close('test complete');
  });
});
