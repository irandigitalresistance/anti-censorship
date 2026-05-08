import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MockBalBus, MockSidecar } from '@webtunnel/shared';
import { Controller } from '../../client-electron/src/main/controller';
import { buildLivekitFactory } from '../../client-electron/src/main/livekit-factory-wiring';
import { ServerController, type ServerStatus } from '../../server-electron/src/main/controller';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function bootBackend(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('controller-webrtc-mock-ok\n');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

function socks5Get(socksPort: number, targetHost: string, targetPort: number): Promise<string> {
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

const envKeys = ['WT_LIVEKIT_MODE', 'WT_MOCK_LIVEKIT_PORT', 'WT_DASHBOARD_PORT', 'WT_DASHBOARD_HOST'] as const;
const originalEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('latest electron server/client with mock webrtc', () => {
  it('round-trips HTTP through the actual controller layer', async () => {
    for (const key of envKeys) originalEnv.set(key, process.env[key]);
    process.env.WT_LIVEKIT_MODE = 'mock';
    process.env.WT_MOCK_LIVEKIT_PORT = String(await freePort());
    // Bind the controller's dashboard to a random port so this test does not
    // collide with a real WebTunnel-Server.exe running on the dev machine.
    process.env.WT_DASHBOARD_PORT = String(await freePort());
    process.env.WT_DASHBOARD_HOST = '127.0.0.1';

    const backend = await bootBackend();
    const bus = new MockBalBus();
    const serverSidecar = new MockSidecar(bus, { id: 500, name: 'server' });
    const clientSidecar = new MockSidecar(bus, { id: 700, name: 'client' });
    const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-e2e-'));
    const server = new ServerController({ sessionFile: path.join(sessionRoot, 'server-session.json') });
    const clientSessionFile = path.join(sessionRoot, 'client-session.json');
    let client: Controller | null = null;

    try {
      const serverMutable = server as unknown as { sidecar: MockSidecar; status: ServerStatus };
      serverMutable.sidecar = serverSidecar;
      serverMutable.status.loginStage = 'ready';
      serverMutable.status.me = { id: 500, name: 'server', phone: null };

      await server.startServer('secret');
      const serverFingerprint = server.getStatus().serverFingerprint;
      if (!serverFingerprint) throw new Error('server fingerprint was not set after start');
      fs.writeFileSync(
        path.join(sessionRoot, 'server-key-pins.json'),
        JSON.stringify({ 'PRIVATE:500': serverFingerprint }, null, 2),
      );
      client = new Controller({
        sessionFile: clientSessionFile,
        livekitFactory: buildLivekitFactory() ?? undefined,
      });

      client.useDemoSession({
        me: { id: 700, name: 'client', phone: null },
        sidecar: clientSidecar,
        listChats: async () => [{
          chat_id: 500,
          chat_type: 'PRIVATE',
          title: 'server',
          username: null,
          unread: 0,
          last_message: null,
        }],
      });

      const socksPort = await freePort();
      await client.startTunnel({
        peer: { chatId: 500, chatType: 'PRIVATE' },
        password: 'secret',
        socksPort,
        serverLabel: 'server',
      });

      const resp = await socks5Get(socksPort, '127.0.0.1', backend.port);
      expect(resp).toContain('HTTP/1.1 200');
      expect(resp).toContain('controller-webrtc-mock-ok');
    } finally {
      if (client) await client.dispose();
      await server.dispose();
      await backend.close();
      await serverSidecar.close();
      await clientSidecar.close();
      fs.rmSync(sessionRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
