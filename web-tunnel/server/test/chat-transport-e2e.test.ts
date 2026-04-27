import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MockBalBus,
  MockSidecar,
  PSK_SALT_INFO,
  deriveKeyFromPassword,
  makeChatTransport,
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
      res.end('echoed-through-chat\n');
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

describe('end-to-end SOCKS5 over ChatTransport (mock Bale bus)', () => {
  let target: { port: number; close: () => Promise<void> };
  const bus = new MockBalBus();
  const server = new MockSidecar(bus, { id: 9001, name: 'server-bot' });
  const client = new MockSidecar(bus, { id: 42, name: 'client-user' });
  const psk = deriveKeyFromPassword('chat-e2e-pass', new TextEncoder().encode(PSK_SALT_INFO));
  let socksPort: number;
  let socksServer: ReturnType<typeof startSocks5Listener> | null = null;

  beforeAll(async () => {
    target = await bootTarget();

    const serverTransport = makeChatTransport({
      sidecar: server,
      peer: { chatId: client.me!.id, chatType: 'PRIVATE' },
    });
    const serverTunnelPromise = runServerTunnel(serverTransport, psk);
    serverTunnelPromise.catch((e) => {
      // eslint-disable-next-line no-console
      console.error('server tunnel failed', e);
    });

    const clientTransport = makeChatTransport({
      sidecar: client,
      peer: { chatId: server.me!.id, chatType: 'PRIVATE' },
    });
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
    await server.close();
    await client.close();
  });

  it('curl-style HTTP GET round-trips through a Bale-chat carrier', async () => {
    const resp = await socks5Connect(socksPort, '127.0.0.1', target.port);
    expect(resp).toContain('HTTP/1.1 200');
    expect(resp).toContain('echoed-through-chat');
  });
});
