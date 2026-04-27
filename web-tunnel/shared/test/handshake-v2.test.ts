import { describe, expect, it } from 'vitest';
import {
  clientHandshakeV2,
  createV2ServerIdentity,
  serverFingerprint,
  serverHandshakeV2,
  type Transport,
} from '../src/index.js';

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

describe('v2 handshake', () => {
  it('authenticates server and derives matching cipher keys', async () => {
    const { a, b } = pair();
    const identity = createV2ServerIdentity();
    const [serverHs, clientHs] = await Promise.all([
      serverHandshakeV2(b, identity),
      clientHandshakeV2(a),
    ]);
    const plain = new TextEncoder().encode('hello-v2');
    const wire = clientHs.cipher.encrypt(plain);
    const pt = serverHs.cipher.decrypt(wire);
    expect(new TextDecoder().decode(pt)).toBe('hello-v2');
    expect(clientHs.serverFingerprint).toBe(serverFingerprint(identity.publicKey));
  });
});
