import {
  deriveRoomName,
  makeLivekitTransport,
  type LivekitRoomFactory,
  type V2ServerIdentity,
  type V2LogReport,
} from '@webtunnel/shared';
import { runServerTunnel, runServerTunnelV2 } from './tunnel.js';
import type { TunnelManager } from './dashboard/manager.js';

/**
 * Server-side WebRTC (LiveKit) endpoint.
 *
 * Mirrors what `BaleServerDispatcher` does for the chat carrier:
 * - Connects into the shared LiveKit room (derived from the PSK).
 * - Wraps the room in a Transport.
 * - Runs the server-side tunnel (handshake + mux + egress) on top.
 *
 * Limitation vs chat: one room = one client (the room name is deterministic
 * from the PSK, so a single room holds at most a matched client+server pair).
 * For multi-client tunneling, mint per-client rooms by adding a client-id
 * suffix to the PSK before deriving the room name. That's a v2 feature.
 */
export interface WebrtcServerOptions {
  factory: LivekitRoomFactory;
  manager: TunnelManager;
  psk?: Uint8Array;
  identity?: V2ServerIdentity;
  protocolVersion?: 1 | 2;
  roomSeed?: Uint8Array;
  onLogReport?: (report: V2LogReport, tunnelId: string | null) => void;
  logger?: (line: string) => void;
}

export async function startWebrtcServer(opts: WebrtcServerOptions): Promise<{ stop: () => Promise<void> }> {
  const { factory, manager, logger } = opts;
  const log = logger ?? (() => undefined);
  const protocolVersion = opts.protocolVersion ?? (opts.identity ? 2 : 1);
  if (protocolVersion === 1 && !opts.psk) throw new Error('startWebrtcServer v1 requires psk');
  if (protocolVersion === 2 && !opts.identity) throw new Error('startWebrtcServer v2 requires identity');
  const roomSeed = opts.roomSeed ?? (protocolVersion === 2
    ? opts.identity!.publicKey
    : opts.psk!);

  const roomName = await deriveRoomName(roomSeed, protocolVersion === 2 ? 'wt2-room' : 'wt-room');
  log(`[webrtc-server] joining room ${roomName} as 'server' (waiting for 'client')`);
  const room = await factory({
    side: 'server', roomName, identity: 'server', peerIdentity: 'client',
  });
  const transport = makeLivekitTransport({ room, peerIdentity: 'client' });

  const { handle, close: closeMgr } = manager.openTunnel(`webrtc:${roomName}`, {
    carrier: 'webrtc',
    protocolVersion,
  });
  let stopped = false;

  const startPromise = protocolVersion === 2
    ? runServerTunnelV2(transport, {
        identity: opts.identity!,
        handle,
        onLogReport: opts.onLogReport,
      }).then((res) => res.mux)
    : runServerTunnel(transport, opts.psk!, { handle });

  startPromise
    .then((mux: { onClose: (cb: (reason: string) => void) => void }) => {
      log(`[webrtc-server] handshake OK for room ${roomName}`);
      mux.onClose((reason) => {
        if (stopped) return;
        stopped = true;
        closeMgr(reason);
        log(`[webrtc-server] tunnel closed: ${reason}`);
      });
    })
    .catch((e) => {
      const reason = `handshake failed: ${(e as Error).message}`;
      stopped = true;
      closeMgr(reason);
      transport.close(reason);
      log(`[webrtc-server] ${reason}`);
    });

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      transport.close('server stop');
      closeMgr('server stop');
      await room.disconnect('server stop');
    },
  };
}
