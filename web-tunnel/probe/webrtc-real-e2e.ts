import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import clientControllerModule from '../client-electron/src/main/controller.ts';
import serverControllerModule from '../server-electron/src/main/controller.ts';

const { Controller } = clientControllerModule as unknown as typeof import('../client-electron/src/main/controller.ts');
const { ServerController } = serverControllerModule as unknown as typeof import('../server-electron/src/main/controller.ts');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function bootBackend(): Promise<{ port: number; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('carrier=webrtc-real\n');
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as net.AddressInfo).port,
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
        sock.write(Buffer.concat([
          Buffer.from([5, 1, 0, 3, hostBytes.byteLength]),
          hostBytes,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]));
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

function log(prefix: string, value: unknown): void {
  if (typeof value === 'string') {
    console.log(prefix, value);
    return;
  }
  console.log(prefix, JSON.stringify(value));
}

async function main(): Promise<void> {
  delete process.env.WT_LIVEKIT_MODE;
  delete process.env.WT_MOCK_LIVEKIT_PORT;

  const server = new ServerController({ sessionFile: `${process.env.USERPROFILE}\\.webtunnel\\server-native-session.json` });
  const probeDir = path.join(process.env.USERPROFILE ?? '.', '.webtunnel', 'probe-real-e2e');
  fs.mkdirSync(probeDir, { recursive: true });
  const client = new Controller({ sessionFile: path.join(probeDir, 'native-session.json') });

  server.on('status', (s) => log('[server-status]', {
    loginStage: s.loginStage,
    running: s.running,
    tunnelsActive: s.tunnelsActive,
    streamsActive: s.streamsActive,
    lastError: s.lastError,
  }));
  client.on('status', (s) => log('[client-status]', {
    loginStage: s.loginStage,
    tunnel: s.tunnel ? { carrier: s.tunnel.carrier, socksPort: s.tunnel.socksPort } : null,
    lastError: s.lastError,
  }));

  let backend: { port: number; close: () => Promise<void> } | null = null;
  try {
    console.log('[probe] init controllers');
    server.init();
    client.init();
    await sleep(1500);

    log('[server-me]', server.getStatus().me);
    if (server.getStatus().loginStage !== 'ready') throw new Error('server session not ready');
    const profiles = JSON.parse(fs.readFileSync(`${process.env.USERPROFILE}\\.webtunnel\\server-client-profiles.json`, 'utf8')) as {
      clients?: Array<{ name?: string; config?: string }>;
    };
    const profile = profiles.clients?.find((client) => client.name === 'E2E test' && client.config)
      ?? profiles.clients?.find((client) => client.config);
    if (!profile?.config) throw new Error('no saved client config found');
    await client.importClientConfig(profile.config);
    await sleep(500);
    log('[client-me]', client.getStatus().me);
    if (client.getStatus().loginStage !== 'ready') throw new Error('client session not ready');

    backend = await bootBackend();
    const socksPort = await freePort();
    const password = 'rtc12345';

    console.log('[probe] start server');
    await withTimeout(server.startServer(password), 30_000, 'server.startServer');
    await sleep(1500);

    const serverId = server.getStatus().me!.id;
    console.log(`[probe] start client webrtc tunnel to ${serverId} on socks ${socksPort}; backend ${backend.port}`);
    await withTimeout(client.startTunnel({
      carrier: 'webrtc',
      peer: { chatId: serverId, chatType: 'PRIVATE' },
      password,
      socksPort,
      serverLabel: 'server',
    }), 120_000, 'client.startTunnel');

    console.log('[probe] tunnel started; fetching local backend through socks');
    const resp = await withTimeout(socks5Get(socksPort, '127.0.0.1', backend.port), 60_000, 'socks5Get');
    console.log('---SOCKS-RESP-START---');
    console.log(resp);
    console.log('---SOCKS-RESP-END---');
  } finally {
    try { await client.dispose(); } catch (e) { console.error('[cleanup-client]', e); }
    try { await server.dispose(); } catch (e) { console.error('[cleanup-server]', e); }
    try { if (backend) await backend.close(); } catch (e) { console.error('[cleanup-backend]', e); }
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (e) { console.error('[cleanup-probe-dir]', e); }
  }
}

main().catch((error) => {
  console.error('[probe-error]', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error);
  process.exit(1);
});
