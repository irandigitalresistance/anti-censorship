import type { LivekitRoomLike } from './livekit-transport.js';

/**
 * A `LivekitRoomFactory` asynchronously produces a connected `LivekitRoomLike`.
 * The tunnel layer is intentionally agnostic about how that happens: the factory
 * encapsulates every choice (real SDK vs mock; Bale-`Meet.GetWssURL` bootstrap vs
 * pre-provisioned URL+token; Node vs browser WebRTC shim) behind a single call.
 *
 * Contract:
 *   - Must resolve with a `LivekitRoomLike` that is **already connected** (i.e.
 *     capable of `publishData` and firing `onDataReceived` callbacks).
 *   - Must reject on any failure to connect; callers will surface the error via
 *     the controller's `lastError`.
 *
 * Convention: the factory receives a `side: 'client' | 'server'` hint so a single
 * factory implementation can mint different tokens / identities for each end.
 */
export interface LivekitConnectContext {
  side: 'client' | 'server';
  /** Stable room name derived from the shared secret — both sides must compute the same value. */
  roomName: string;
  /** Logical participant identity; 'client' and 'server' by convention. */
  identity: string;
  /** The remote participant identity we expect to tunnel with. */
  peerIdentity: string;
}

export type LivekitRoomFactory = (ctx: LivekitConnectContext) => Promise<LivekitRoomLike>;

/**
 * Deterministically derive a LiveKit room name from the pre-shared key so both
 * ends arrive at the same room without out-of-band coordination. The PSK is
 * hashed, not disclosed.
 *
 * Uses the Web Crypto API — available in Node >= 20 and all browsers.
 */
export async function deriveRoomName(psk: Uint8Array, suffix = 'wt-room'): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', psk);
  const hex = Array.from(new Uint8Array(buf))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${suffix}-${hex}`;
}
