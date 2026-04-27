import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startSocks5Listener } from '../src/socks5.js';

function listenOnce(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

describe('SOCKS5 listener errors', () => {
  it('surfaces EADDRINUSE via onError instead of crashing', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (blocker.address() as AddressInfo).port;

    let listener: unknown = null;
    try {
      const err = await new Promise<Error>((resolve, reject) => {
        listener = startSocks5Listener({
          host: '127.0.0.1',
          port,
          mux: { openStream: () => { throw new Error('unused'); } },
          onError: (e) => resolve(e),
        });
        setTimeout(() => reject(new Error('expected socks5 listen error')), 1_500);
      });
      expect(err.message).toContain('EADDRINUSE');
    } finally {
      const activeListener = listener;
      if (activeListener instanceof net.Server) {
        try { activeListener.close(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
