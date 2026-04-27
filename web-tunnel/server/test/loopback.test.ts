import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { TunnelMux, clientHandshake, deriveKeyFromPassword, PSK_SALT_INFO } from '@webtunnel/shared';
import { wrapServerWebSocket } from '../src/transports/ws-server.js';
import { runServerTunnel } from '../src/tunnel.js';

const encoder = new TextEncoder();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function bootTestHttpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Echo-Path': req.url ?? '' });
      res.end('hello from target\n');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            srv.close(() => r());
          }),
      });
    });
  });
}

interface TunnelRig {
  tunnelPort: number;
  wsServer: WebSocketServer;
  httpServer: http.Server;
  close: () => Promise<void>;
}

async function bootTunnelServer(psk: Uint8Array): Promise<TunnelRig> {
  const port = await freePort();
  const httpServer = http.createServer((_req, res) => res.end('tunnel server'));
  const wsServer = new WebSocketServer({ server: httpServer, path: '/tunnel' });
  wsServer.on('connection', async (ws) => {
    const transport = wrapServerWebSocket(ws);
    try {
      await runServerTunnel(transport, psk);
    } catch {
      ws.close(1008);
    }
  });
  await new Promise<void>((r) => httpServer.listen(port, '127.0.0.1', () => r()));
  return {
    tunnelPort: port,
    wsServer,
    httpServer,
    close: async () => {
      for (const ws of wsServer.clients) ws.terminate();
      await new Promise<void>((r) => wsServer.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

async function openClientMux(tunnelUrl: string, psk: Uint8Array): Promise<{ mux: TunnelMux; close: () => void }> {
  const ws = new WebSocket(tunnelUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
  });
  let onMessage: ((b: Uint8Array) => void) | null = null;
  let onClose: ((r: string) => void) | null = null;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    let buf: Buffer;
    if (Array.isArray(data)) buf = Buffer.concat(data);
    else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else buf = data;
    onMessage?.(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  });
  ws.on('close', (code, reason) => onClose?.(reason.toString('utf8') || `closed ${code}`));
  const transport = {
    send(bytes: Uint8Array) {
      ws.send(bytes, { binary: true });
    },
    onMessage(cb: (b: Uint8Array) => void) {
      onMessage = cb;
    },
    onClose(cb: (r: string) => void) {
      onClose = cb;
    },
    close(reason = 'done') {
      ws.close(1000, reason);
    },
  };
  const cipher = await clientHandshake(transport, psk);
  const mux = new TunnelMux({ transport, cipher, role: 'client' });
  return {
    mux,
    close: () => {
      ws.terminate();
    },
  };
}

describe('loopback end-to-end', () => {
  let psk: Uint8Array;
  let rig: TunnelRig;
  let target: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    psk = deriveKeyFromPassword('integration-test-pass', encoder.encode(PSK_SALT_INFO));
    rig = await bootTunnelServer(psk);
    target = await bootTestHttpServer();
  });

  afterAll(async () => {
    await rig.close();
    await target.close();
  });

  it('pipes an HTTP GET through the tunnel', async () => {
    const { mux, close } = await openClientMux(`ws://127.0.0.1:${rig.tunnelPort}/tunnel`, psk);
    try {
      const stream = mux.openStream({ kind: 'ipv4', host: '127.0.0.1', port: target.port });
      const chunks: Uint8Array[] = [];
      const done = new Promise<void>((resolve) => {
        stream.onData((d) => chunks.push(d));
        stream.onClose(() => resolve());
      });
      stream.write(
        encoder.encode(`GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nConnection: close\r\n\r\n`),
      );
      await done;
      const response = new TextDecoder().decode(
        chunks.reduce((acc, c) => {
          const next = new Uint8Array(acc.byteLength + c.byteLength);
          next.set(acc);
          next.set(c, acc.byteLength);
          return next;
        }, new Uint8Array()),
      );
      expect(response).toContain('HTTP/1.1 200');
      expect(response).toContain('X-Echo-Path: /hello');
      expect(response).toContain('hello from target');
    } finally {
      close();
    }
  });

  it('rejects a client using the wrong PSK', async () => {
    const wrongPsk = deriveKeyFromPassword('wrong-pass', encoder.encode(PSK_SALT_INFO));
    await expect(openClientMux(`ws://127.0.0.1:${rig.tunnelPort}/tunnel`, wrongPsk)).rejects.toThrow();
  });
});
