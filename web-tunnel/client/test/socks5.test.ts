import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionCipher, TunnelMux, deriveKeyFromPassword, PSK_SALT_INFO } from '@webtunnel/shared';
import { runServerTunnel, wrapServerWebSocket } from '@webtunnel/server';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { startSocks5Listener } from '../src/socks5.js';
import { clientHandshake } from '@webtunnel/shared';

const encoder = new TextEncoder();

function bootTargetServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('socks-target\n');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function boot() {
  const psk = deriveKeyFromPassword('socks-test-pass', encoder.encode(PSK_SALT_INFO));
  const target = await bootTargetServer();
  const tunnelPort = await freePort();
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer, path: '/tunnel' });
  wsServer.on('connection', async (ws) => {
    const transport = wrapServerWebSocket(ws);
    try {
      await runServerTunnel(transport, psk);
    } catch {
      ws.close(1008);
    }
  });
  await new Promise<void>((r) => httpServer.listen(tunnelPort, '127.0.0.1', () => r()));

  const clientWs = new WebSocket(`ws://127.0.0.1:${tunnelPort}/tunnel`);
  await new Promise<void>((resolve, reject) => {
    clientWs.once('open', () => resolve());
    clientWs.once('error', reject);
  });
  let onMessage: ((b: Uint8Array) => void) | null = null;
  let onClose: ((r: string) => void) | null = null;
  clientWs.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let buf: Buffer;
    if (Array.isArray(data)) buf = Buffer.concat(data);
    else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else buf = data;
    onMessage?.(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  });
  clientWs.on('close', (code, reason) => onClose?.(reason.toString('utf8') || `closed ${code}`));
  const transport = {
    send(bytes: Uint8Array) {
      clientWs.send(bytes, { binary: true });
    },
    onMessage(cb: (b: Uint8Array) => void) {
      onMessage = cb;
    },
    onClose(cb: (r: string) => void) {
      onClose = cb;
    },
    close(r = 'done') {
      clientWs.close(1000, r);
    },
  };
  const cipher = await clientHandshake(transport, psk);
  const mux = new TunnelMux({ transport, cipher, role: 'client' });
  const socksPort = await freePort();
  const listener = startSocks5Listener({ host: '127.0.0.1', port: socksPort, mux });
  await new Promise<void>((r) => listener.once('listening', () => r()));

  return {
    target,
    socksPort,
    close: async () => {
      listener.close();
      clientWs.terminate();
      for (const ws of wsServer.clients) ws.terminate();
      await new Promise<void>((r) => wsServer.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
      await target.close();
    },
  };
}

function socks5ConnectAndGet(
  socksPort: number,
  targetHost: string,
  targetPort: number,
  path = '/',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: socksPort });
    const chunks: Buffer[] = [];
    let state: 'greet' | 'connect' | 'data' = 'greet';
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      if (state === 'greet') {
        if (chunk.byteLength < 2 || chunk[0] !== 5 || chunk[1] !== 0) return reject(new Error('bad greet'));
        const hostBytes = Buffer.from(targetHost);
        const req = Buffer.concat([
          Buffer.from([5, 1, 0, 3, hostBytes.byteLength]),
          hostBytes,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
        sock.write(req);
        state = 'connect';
        return;
      }
      if (state === 'connect') {
        if (chunk[0] !== 5 || chunk[1] !== 0) return reject(new Error(`socks5 failure code ${chunk[1]}`));
        state = 'data';
        const leftover = chunk.length > 10 ? chunk.subarray(10) : Buffer.alloc(0);
        sock.write(
          `GET ${path} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`,
        );
        if (leftover.byteLength > 0) chunks.push(leftover);
        return;
      }
      chunks.push(chunk);
    });
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.write(Uint8Array.of(5, 1, 0));
  });
}

describe('SOCKS5 listener end-to-end', () => {
  let rig: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    rig = await boot();
  });

  afterAll(async () => {
    await rig.close();
  });

  it('proxies an HTTP GET via SOCKS5 CONNECT over the tunnel', async () => {
    const resp = await socks5ConnectAndGet(rig.socksPort, '127.0.0.1', rig.target.port, '/check');
    expect(resp).toContain('HTTP/1.1 200');
    expect(resp).toContain('socks-target');
  });
});
