import type { LivekitRoomLike, LivekitRoomFactory, LivekitConnectContext } from '@webtunnel/shared';

/**
 * Real-LiveKit adapter factory.
 *
 * This file intentionally does NOT hard-require `@livekit/rtc-node` or
 * `livekit-client`. Native LiveKit SDKs ship platform-specific binaries and
 * we don't want the tunnel to fail to import on machines that never switch
 * to the WebRTC carrier. Instead you inject the SDK you chose at call time.
 *
 * How to use (drop the LiveKit SDK in later, zero changes to the tunnel):
 *
 *   import { Room, RoomEvent } from '@livekit/rtc-node';
 *   import { makeLivekitRoomFactory } from './livekit-rtc-node.js';
 *
 *   const factory = makeLivekitRoomFactory({
 *     url: process.env.LIVEKIT_URL!,
 *     mintToken: async (ctx) => mintAccessToken(ctx),   // livekit-server-sdk
 *     createRoom: () => new Room(),
 *   });
 *
 * Then pass `factory` wherever the codebase asks for a `LivekitRoomFactory`.
 *
 * `mintToken` is user-supplied so you can choose between server-side minting
 * (via `livekit-server-sdk`'s AccessToken) or grabbing a token from Bale's
 * `Meet.GetWssURL` RPC — either path lands us at the same `LivekitRoomLike`.
 */

export interface MakeLivekitFactoryOptions {
  /** wss://… or ws://… URL to the LiveKit server. */
  url: string;
  /** Per-connection token minter. Receives the connect context; returns a JWT. */
  mintToken: (ctx: LivekitConnectContext) => Promise<string>;
  /** Factory for a not-yet-connected LiveKit Room object (matches the SDK's `new Room()`). */
  createRoom: () => LivekitRoomObjectLike;
  /** Optional: override the URL per-call (e.g. if GetWssURL returns a different URL each time). */
  urlFor?: (ctx: LivekitConnectContext) => Promise<string>;
}

/**
 * Minimal surface of a LiveKit `Room` object we rely on. Stays compatible with
 * both `@livekit/rtc-node` and `livekit-client` — the two share this API shape
 * for the methods we touch.
 */
export interface LivekitRoomObjectLike {
  localParticipant: { identity: string; publishData: (bytes: Uint8Array, opts?: { reliable?: boolean; destination_identities?: string[] }) => Promise<void> };
  connect(url: string, token: string, options?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export function makeLivekitRoomFactory(opts: MakeLivekitFactoryOptions): LivekitRoomFactory {
  return async (ctx) => {
    const url = opts.urlFor ? await opts.urlFor(ctx) : opts.url;
    const token = await opts.mintToken(ctx);
    const room = opts.createRoom();

    await room.connect(url, token, { autoSubscribe: true });

    const dataHandlers = new Set<(bytes: Uint8Array, fromIdentity: string) => void>();
    const discHandlers = new Set<(reason: string) => void>();

    // `DataReceived` event signature across LiveKit SDKs is
    // `(payload: Uint8Array, participant?, kind?, topic?)`.
    // The `participant` object has an `identity` property.
    room.on('dataReceived', (...args: unknown[]) => {
      const payload = args[0] as Uint8Array;
      const participant = args[1] as { identity?: string } | undefined;
      for (const cb of dataHandlers) cb(payload, participant?.identity ?? 'unknown');
    });
    room.on('disconnected', (reason?: unknown) => {
      const msg = typeof reason === 'string' ? reason : 'disconnected';
      for (const cb of discHandlers) cb(msg);
    });

    const surface: LivekitRoomLike = {
      localIdentity: room.localParticipant.identity,
      async publishData(bytes, publishOpts) {
        await room.localParticipant.publishData(bytes, {
          reliable: publishOpts?.reliable ?? true,
          destination_identities: publishOpts?.destinationIdentities ?? [],
        });
      },
      onDataReceived(cb) {
        dataHandlers.add(cb);
        return () => dataHandlers.delete(cb);
      },
      onDisconnect(cb) {
        discHandlers.add(cb);
        return () => discHandlers.delete(cb);
      },
      async disconnect() {
        await room.disconnect();
      },
    };
    return surface;
  };
}
