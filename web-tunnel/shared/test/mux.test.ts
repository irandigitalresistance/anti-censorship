import { describe, expect, it } from 'vitest';
import { SessionCipher } from '../src/handshake.js';
import { TunnelMux } from '../src/mux.js';
import type { Transport } from '../src/transport.js';

function pair(): { a: Transport; b: Transport } {
  let aMsg: ((b: Uint8Array) => void) | null = null;
  let bMsg: ((b: Uint8Array) => void) | null = null;
  let aClose: ((r: string) => void) | null = null;
  let bClose: ((r: string) => void) | null = null;
  const a: Transport = {
    send(bytes) {
      queueMicrotask(() => bMsg?.(bytes));
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
  };
  const b: Transport = {
    send(bytes) {
      queueMicrotask(() => aMsg?.(bytes));
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
  };
  return { a, b };
}

describe('TunnelMux', () => {
  it('opens a stream and delivers bidirectional DATA frames', async () => {
    const psk = new Uint8Array(32);
    const cipher = SessionCipher.derive(psk, new Uint8Array(16), new Uint8Array(16));
    const { a, b } = pair();
    const client = new TunnelMux({ transport: a, cipher, role: 'client' });
    const server = new TunnelMux({ transport: b, cipher, role: 'server' });

    const serverSide = new Promise<{ addr: string; port: number }>((resolve) => {
      server.onStream((s) => {
        if (s.addr.kind !== 'domain') throw new Error('unexpected addr kind');
        s.onData((d) => s.write(new Uint8Array([...d, 0x21])));
        resolve({ addr: s.addr.host, port: s.addr.port });
      });
    });

    const stream = client.openStream({ kind: 'domain', host: 'example.com', port: 443 });
    const echoed = new Promise<Uint8Array>((resolve) => stream.onData(resolve));
    stream.write(new TextEncoder().encode('hi'));

    const got = await echoed;
    expect(new TextDecoder().decode(got)).toBe('hi!');
    const addr = await serverSide;
    expect(addr).toEqual({ addr: 'example.com', port: 443 });
  });

  it('propagates remote close to the other side', async () => {
    const psk = new Uint8Array(32);
    const cipher = SessionCipher.derive(psk, new Uint8Array(16), new Uint8Array(16));
    const { a, b } = pair();
    const client = new TunnelMux({ transport: a, cipher, role: 'client' });
    const server = new TunnelMux({ transport: b, cipher, role: 'server' });

    const serverStream = new Promise<import('../src/mux.js').Stream>((resolve) => server.onStream(resolve));
    const s = client.openStream({ kind: 'domain', host: 'x', port: 1 });
    const ss = await serverStream;
    const closed = new Promise<void>((resolve) => ss.onClose(() => resolve()));
    s.close();
    await closed;
    expect(ss.closed).toBe(true);
  });

  it('rejects wire bytes encrypted under a different session', async () => {
    const { a, b } = pair();
    const psk = new Uint8Array(32);
    const sessClient = SessionCipher.derive(psk, new Uint8Array(16), new Uint8Array(16));
    const psk2 = new Uint8Array(32);
    psk2[0] = 1;
    const sessServer = SessionCipher.derive(psk2, new Uint8Array(16), new Uint8Array(16));
    const client = new TunnelMux({ transport: a, cipher: sessClient, role: 'client' });
    const server = new TunnelMux({ transport: b, cipher: sessServer, role: 'server' });

    const serverClosed = new Promise<string>((resolve) => server.onClose(resolve));
    client.openStream({ kind: 'domain', host: 'x', port: 1 });
    const reason = await serverClosed;
    expect(reason).toMatch(/decrypt/);
  });
});
