import { describe, expect, it } from 'vitest';
import { SessionCipher } from '../src/handshake.js';
import { TunnelMuxV2 } from '../src/mux-v2.js';
import type { Transport } from '../src/transport.js';

function pair(): { a: Transport; b: Transport } {
  let aMsg: ((b: Uint8Array) => void) | null = null;
  let bMsg: ((b: Uint8Array) => void) | null = null;
  let aClose: ((r: string) => void) | null = null;
  let bClose: ((r: string) => void) | null = null;
  return {
    a: {
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
    },
    b: {
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
    },
  };
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
});
