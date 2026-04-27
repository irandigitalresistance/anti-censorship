import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MockLivekitBus,
  MockLivekitRoom,
  PSK_SALT_INFO,
  deriveKeyFromPassword,
  type LivekitRoomFactory,
} from '@webtunnel/shared';
import { PythonSidecar } from './bale-session/python-sidecar.js';
import { BaleServerDispatcher } from './bale-session/server-dispatcher.js';
import { TunnelManager } from './dashboard/manager.js';
import { startDashboard } from './dashboard/server.js';
import { startWebrtcServer } from './webrtc-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function envOrDefault(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function resolveSidecarCwd(): string {
  return envOrDefault('WT_SIDECAR_CWD', path.resolve(__dirname, '../py'));
}

function resolvePython(): string {
  const cwd = resolveSidecarCwd();
  const candidates = process.platform === 'win32'
    ? [path.join(cwd, '.venv', 'Scripts', 'python.exe'), 'python.exe', 'python']
    : [path.join(cwd, '.venv', 'bin', 'python'), '/usr/bin/python3', 'python3'];
  for (const c of candidates) {
    if (path.isAbsolute(c) && fs.existsSync(c)) return c;
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function resolveSessionFile(): string {
  const cfgDir = path.join(os.homedir(), '.webtunnel');
  if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
  return envOrDefault('WT_SESSION_FILE', path.join(cfgDir, 'server-session.bale'));
}

async function main(): Promise<void> {
  const password = process.env.WT_PASSWORD;
  if (!password) {
    console.error('[server] WT_PASSWORD is required. Set it to the shared secret you give to clients.');
    console.error('         Example: WT_PASSWORD=my-long-shared-secret pnpm --filter @webtunnel/server bale');
    process.exit(2);
  }

  const sessionFile = resolveSessionFile();
  if (!fs.existsSync(sessionFile)) {
    console.error(`[server] Bale session file not found at ${sessionFile}`);
    console.error('         Run the one-time login:');
    console.error(`           cd server/py && python -m bale_sidecar login --session "${sessionFile}"`);
    process.exit(3);
  }

  const python = envOrDefault('WT_PYTHON', resolvePython());
  const sidecarCwd = resolveSidecarCwd();

  const manager = new TunnelManager();
  manager.start();
  const dashboardPort = Number(envOrDefault('WT_DASHBOARD_PORT', '4402'));
  const dashboardHost = envOrDefault('WT_DASHBOARD_HOST', '127.0.0.1');
  startDashboard({ manager, port: dashboardPort, host: dashboardHost });
  console.log(`[server] dashboard on http://${dashboardHost}:${dashboardPort}/`);

  console.log(`[server] spawning Bale sidecar (python=${python}, session=${sessionFile})`);
  const sidecar = new PythonSidecar({ python, sessionFile, cwd: sidecarCwd });
  try {
    await sidecar.readyPromise;
  } catch (e) {
    console.error(`[server] sidecar failed to become ready: ${(e as Error).message}`);
    process.exit(4);
  }
  console.log(`[server] logged in as ${sidecar.me?.name ?? 'unknown'} (id=${sidecar.me?.id})`);
  sidecar.onClose((reason) => {
    console.error(`[server] sidecar closed: ${reason}`);
    process.exit(5);
  });

  const psk = deriveKeyFromPassword(password, new TextEncoder().encode(PSK_SALT_INFO));
  const dispatcher = new BaleServerDispatcher(sidecar, psk, manager, {
    logger: (line) => console.log(`[dispatch] ${line}`),
  });
  dispatcher.start();

  // Optional WebRTC carrier, env-gated.
  const livekitFactory = buildServerLivekitFactory();
  let webrtcStop: (() => Promise<void>) | null = null;
  if (livekitFactory) {
    try {
      const { stop } = await startWebrtcServer({
        factory: livekitFactory,
        psk,
        manager,
        logger: (line) => console.log(line),
      });
      webrtcStop = stop;
      console.log('[server] WebRTC carrier live. Same password unlocks both chat and WebRTC tunnels.');
    } catch (e) {
      console.warn(`[server] WebRTC carrier failed to start: ${(e as Error).message}`);
    }
  } else {
    console.log('[server] WebRTC carrier disabled (set WT_LIVEKIT_MODE=real|mock to enable).');
  }

  console.log('[server] ready. Clients who know the shared password can now open tunnels by chatting with this account.');

  const shutdown = async (): Promise<void> => {
    console.log('\n[server] shutting down…');
    dispatcher.stop();
    if (webrtcStop) await webrtcStop();
    await sidecar.close();
    manager.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function buildServerLivekitFactory(): LivekitRoomFactory | null {
  const mode = process.env.WT_LIVEKIT_MODE;
  if (!mode) return null;
  if (mode === 'mock') {
    const bus = new MockLivekitBus();
    return async (ctx) => new MockLivekitRoom(bus, ctx.identity);
  }
  if (mode === 'real') {
    // Mirrors client-electron/src/main/livekit-factory-wiring.ts — lazy-loaded.
    const url = process.env.LIVEKIT_URL;
    if (!url) throw new Error('WT_LIVEKIT_MODE=real but LIVEKIT_URL is not set');
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const staticToken = process.env.LIVEKIT_ACCESS_TOKEN;
    if (!staticToken && !(apiKey && apiSecret)) {
      throw new Error('LIVEKIT_ACCESS_TOKEN or LIVEKIT_API_KEY+LIVEKIT_API_SECRET required');
    }
    return async (ctx) => {
      // Strings as variables so TS doesn't try to resolve these optional deps at compile time.
      const LK_CLIENT = 'livekit-client';
      const LK_SERVER = 'livekit-server-sdk';
      let sdk: any;
      try {
        sdk = await import(LK_CLIENT);
      } catch (e) {
        throw new Error(
          `cannot import 'livekit-client' (install with: pnpm --filter @webtunnel/server add livekit-client): ${(e as Error).message}`,
        );
      }
      let token: string;
      if (staticToken) {
        token = staticToken;
      } else {
        let srv: any;
        try {
          srv = await import(LK_SERVER);
        } catch (e) {
          throw new Error(
            `cannot import 'livekit-server-sdk' (install with: pnpm --filter @webtunnel/server add livekit-server-sdk): ${(e as Error).message}`,
          );
        }
        const at = new srv.AccessToken(apiKey, apiSecret, { identity: ctx.identity });
        at.addGrant({ roomJoin: true, room: ctx.roomName, canPublish: true, canSubscribe: true, canPublishData: true });
        token = await at.toJwt();
      }
      const room = new sdk.Room();
      await room.connect(url, token, { autoSubscribe: true });
      const dataHandlers = new Set<(bytes: Uint8Array, from: string) => void>();
      const discHandlers = new Set<(reason: string) => void>();
      room.on(sdk.RoomEvent.DataReceived, (payload: Uint8Array, participant: any) => {
        for (const cb of dataHandlers) cb(payload, participant?.identity ?? 'unknown');
      });
      room.on(sdk.RoomEvent.Disconnected, (reason: any) => {
        const msg = typeof reason === 'string' ? reason : 'disconnected';
        for (const cb of discHandlers) cb(msg);
      });
      return {
        localIdentity: room.localParticipant.identity,
        async publishData(bytes, opts) {
          await room.localParticipant.publishData(bytes, {
            reliable: opts?.reliable ?? true,
            destinationIdentities: opts?.destinationIdentities ?? [],
          });
        },
        onDataReceived(cb) { dataHandlers.add(cb); return () => dataHandlers.delete(cb); },
        onDisconnect(cb) { discHandlers.add(cb); return () => discHandlers.delete(cb); },
        async disconnect() { await room.disconnect(); },
      };
    };
  }
  throw new Error(`unknown WT_LIVEKIT_MODE: ${mode}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
