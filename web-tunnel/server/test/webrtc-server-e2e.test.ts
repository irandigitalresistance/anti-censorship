/**
 * End-to-end test for the carrier-switch WebRTC path, using `startWebrtcServer`
 * on the server side and the same primitives the client-electron controller
 * uses on the client side. Proves:
 *
 *   1. `deriveRoomName(psk)` is deterministic (both sides meet in the same room).
 *   2. `startWebrtcServer` connects into the LiveKit room and runs the full
 *      server-side tunnel (handshake + mux + egress).
 *   3. A client wrapped in `makeLivekitTransport` + `runClientTunnel` can
 *      complete the handshake and round-trip SOCKS5 traffic to a real
 *      HTTP backend.
 *
 * Uses `MockLivekitBus` so no external LiveKit infra is required.
 */

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MockLivekitBus,
  MockLivekitRoom,
  PSK_SALT_INFO,
  deriveKeyFromPassword,
  deriveRoomName,
  makeLivekitTransport,
  type LivekitRoomFactory,
} from '@webtunnel/shared';
import { runClientTunnel } from '../../client/src/tunnel.js';
import { startSocks5Listener } from '../../client/src/socks5.js';
import { TunnelManager } from '../src/dashboard/manager.js';
import { startWebrtcServer } from '../src/webrtc-server.js';

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
      res.end('carrier=webrtc\n');
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
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

describe('webrtc carrier: server dispatcher + client controller path', () => {
  const psk = deriveKeyFromPassword('webrtc-carrier-test', new TextEncoder().encode(PSK_SALT_INFO));

  it('deriveRoomName is deterministic per PSK', async () => {
    const a = await deriveRoomName(psk);
    const b = await deriveRoomName(psk);
    expect(a).toBe(b);
    const c = await deriveRoomName(
      deriveKeyFromPassword('different', new TextEncoder().encode(PSK_SALT_INFO)),
    );
    expect(c).not.toBe(a);
    // Room name embeds a 12-byte hex digest.
    expect(a).toMatch(/^wt-room-[0-9a-f]{24}$/);
  });

  describe('round-trip HTTP via SOCKS5 → client mux → LiveKit mock → server dispatcher', () => {
    const bus = new MockLivekitBus();
    const manager = new TunnelManager();
    let backend: { port: number; close: () => Promise<void> };
    let socksPort: number;
    let socksServer: ReturnType<typeof startSocks5Listener> | null = null;
    let stopServer: () => Promise<void> = async () => undefined;

    // Shared factory: the client uses identity='client', server uses 'server'.
    const factory: LivekitRoomFactory = async (ctx) => new MockLivekitRoom(bus, ctx.identity);

    beforeAll(async () => {
      backend = await bootBackend();
      manager.start();

      // Server side: start the webrtc dispatcher. It joins the room as 'server'
      // and waits for 'client' to send frames (tunnel handshake).
      const { stop } = await startWebrtcServer({
        factory,
        psk,
        manager,
        logger: (line) => {
          if (process.env.WT_TEST_DEBUG) console.log(line);
        },
      });
      stopServer = stop;

      // Client side: mimic what client-electron Controller.startTunnel({carrier:'webrtc'}) does.
      const roomName = await deriveRoomName(psk);
      const room = await factory({
        side: 'client', roomName, identity: 'client', peerIdentity: 'server',
      });
      const transport = makeLivekitTransport({ room, peerIdentity: 'server' });
      const mux = await runClientTunnel(transport, psk);

      socksPort = await freePort();
      socksServer = startSocks5Listener({ host: '127.0.0.1', port: socksPort, mux });
      await new Promise<void>((r) => {
        if (socksServer!.listening) r();
        else socksServer!.once('listening', () => r());
      });
    }, 15_000);

    afterAll(async () => {
      socksServer?.close();
      await stopServer();
      await backend.close();
      bus.disconnectAll('test teardown');
      manager.stop();
    });

    it('round-trips HTTP through WebRTC tunnel', async () => {
      const resp = await socks5Get(socksPort, '127.0.0.1', backend.port);
      expect(resp).toContain('HTTP/1.1 200');
      expect(resp).toContain('carrier=webrtc');
    });

    it('same tunnel handles multiple sequential streams', async () => {
      for (let i = 0; i < 3; i++) {
        const resp = await socks5Get(socksPort, '127.0.0.1', backend.port);
        expect(resp).toContain('200');
      }
    });
  });
});
