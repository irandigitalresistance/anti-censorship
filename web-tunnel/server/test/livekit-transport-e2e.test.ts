import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MockLivekitBus,
  MockLivekitRoom,
  PSK_SALT_INFO,
  deriveKeyFromPassword,
  makeLivekitTransport,
} from '@webtunnel/shared';
import { runServerTunnel } from '../src/tunnel.js';
import { startSocks5Listener } from '../../client/src/socks5.js';
import { runClientTunnel } from '../../client/src/tunnel.js';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function bootTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('echoed-through-livekit\n');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

function socks5Connect(socksPort: number, targetHost: string, targetPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: socksPort });
    const chunks: Buffer[] = [];
    let state: 'greet' | 'connect' | 'data' = 'greet';
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      if (state === 'greet') {
        if (chunk[0] !== 5 || chunk[1] !== 0) return reject(new Error('bad greet'));
        const hostBytes = Buffer.from(targetHost);
        sock.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, hostBytes.byteLength]),
            hostBytes,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]),
        );
        state = 'connect';
        return;
      }
      if (state === 'connect') {
        if (chunk[0] !== 5 || chunk[1] !== 0) return reject(new Error(`socks5 failure ${chunk[1]}`));
        state = 'data';
        const leftover = chunk.length > 10 ? chunk.subarray(10) : Buffer.alloc(0);
        sock.write(`GET / HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`);
        if (leftover.byteLength > 0) chunks.push(leftover);
        return;
      }
      chunks.push(chunk);
    });
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.write(Uint8Array.of(5, 1, 0));
  });
}

describe('end-to-end SOCKS5 over LivekitTransport (mock LiveKit bus)', () => {
  let target: { port: number; close: () => Promise<void> };
  const bus = new MockLivekitBus();
  const serverRoom = new MockLivekitRoom(bus, 'server-bot');
  const clientRoom = new MockLivekitRoom(bus, 'client-user');
  const psk = deriveKeyFromPassword('livekit-e2e-pass', new TextEncoder().encode(PSK_SALT_INFO));
  let socksPort: number;
  let socksServer: ReturnType<typeof startSocks5Listener> | null = null;

  beforeAll(async () => {
    target = await bootTarget();
    const serverTransport = makeLivekitTransport({ room: serverRoom, peerIdentity: 'client-user' });
    const serverTunnelPromise = runServerTunnel(serverTransport, psk);
    serverTunnelPromise.catch((e) => {
      // eslint-disable-next-line no-console
      console.error('server tunnel failed', e);
    });
    const clientTransport = makeLivekitTransport({ room: clientRoom, peerIdentity: 'server-bot' });
    const [, mux] = await Promise.all([serverTunnelPromise, runClientTunnel(clientTransport, psk)]);
    socksPort = await freePort();
    socksServer = startSocks5Listener({ host: '127.0.0.1', port: socksPort, mux });
    await new Promise<void>((r) => {
      if (socksServer!.listening) r();
      else socksServer!.once('listening', () => r());
    });
  }, 15_000);

  afterAll(async () => {
    socksServer?.close();
    await target.close();
    bus.disconnectAll('test teardown');
  });

  it('round-trips HTTP through LiveKit data channel', async () => {
    const resp = await socks5Connect(socksPort, '127.0.0.1', target.port);
    expect(resp).toContain('HTTP/1.1 200');
    expect(resp).toContain('echoed-through-livekit');
  });

  it('sustained throughput: 256KB streamed in one request', async () => {
    const big = Buffer.alloc(256 * 1024, 0xAB);
    const bigServer = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Length': String(big.byteLength) });
        res.end(big);
      });
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as AddressInfo).port;
        resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
      });
    });
    try {
      const resp = await socks5Connect(socksPort, '127.0.0.1', bigServer.port);
      expect(resp.length).toBeGreaterThan(256 * 1024);
      expect(resp).toContain('HTTP/1.1 200');
    } finally {
      await bigServer.close();
    }
  }, 15_000);
});
