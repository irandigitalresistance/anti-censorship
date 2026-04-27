import type { Transport } from './transport.js';

/**
 * Environment-agnostic surface over a LiveKit Room that our LivekitTransport
 * consumes. Real implementations on Node use `@livekit/rtc-node`; in the browser
 * / Electron renderer they use `livekit-client`. Mock implementations live in
 * `mock-livekit.ts` and connect via an in-memory bus.
 */
export interface LivekitRoomLike {
  readonly localIdentity: string;
  /**
   * Send a data-channel packet. `reliable` maps to LiveKit's DataPacket_Kind.
   * `destinationIdentities` restricts delivery to the listed participants; an
   * empty/undefined array means broadcast.
   */
  publishData(
    bytes: Uint8Array,
    opts?: { reliable?: boolean; destinationIdentities?: string[] },
  ): Promise<void>;
  /** Register a callback for incoming data packets. Returns an unsubscribe. */
  onDataReceived(cb: (bytes: Uint8Array, fromIdentity: string) => void): () => void;
  /** Register a callback for room disconnect / participant disconnect that invalidates this transport. */
  onDisconnect(cb: (reason: string) => void): () => void;
  /** Tear down the local participant. */
  disconnect(reason?: string): Promise<void>;
}

export interface LivekitTransportOptions {
  room: LivekitRoomLike;
  /**
   * Optional identity of the single remote peer we tunnel with.
   *
   * When omitted, the transport treats the room as a two-party broadcast
   * channel: it accepts any non-self packet and broadcasts outbound packets.
   * Bale Meet uses opaque token-derived participant identities, so the caller
   * often cannot know the peer identity ahead of time.
   */
  peerIdentity?: string | null;
  /** Defaults to true; use `false` for low-latency lossy data (e.g. UDP-ish). */
  reliable?: boolean;
}

export function makeLivekitTransport(opts: LivekitTransportOptions): Transport {
  const { room } = opts;
  const reliable = opts.reliable ?? true;
  const peerIdentity = opts.peerIdentity ?? null;
  let onMessage: ((bytes: Uint8Array) => void) | null = null;
  let onClose: ((reason: string) => void) | null = null;
  let closed = false;

  const offData = room.onDataReceived((bytes, fromIdentity) => {
    if (closed) return;
    if (fromIdentity === room.localIdentity) return;
    if (peerIdentity != null && fromIdentity !== peerIdentity) return;
    onMessage?.(bytes);
  });
  const offDisc = room.onDisconnect((reason) => {
    if (closed) return;
    closed = true;
    onClose?.(reason);
  });

  return {
    async send(bytes) {
      if (closed) return;
      try {
        await room.publishData(bytes, peerIdentity
          ? { reliable, destinationIdentities: [peerIdentity] }
          : { reliable });
      } catch (e) {
        if (closed) return;
        closed = true;
        onClose?.(`publishData failed: ${(e as Error).message}`);
      }
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
      if (closed) cb('already closed');
    },
    close(reason = 'livekit-transport closed') {
      if (closed) return;
      closed = true;
      offData();
      offDisc();
      void room.disconnect(reason);
      onClose?.(reason);
    },
  };
}
