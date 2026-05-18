import type { LivekitConnectContext, LivekitRoomFactory } from '../livekit-factory.js';
import type { LivekitRoomLike } from '../livekit-transport.js';
import type { BaleClient } from './client.js';
import { makeRtcNodeVideoPacketCarrier, type RtcNodeVideoPacketCarrier } from './media-video-carrier.js';
import { buildLiveKitUrl, type Peer, type StartCallResult } from './messages.js';

export const LIVEKIT_DATA_DISABLED_CODE = 'BALE_LIVEKIT_DATA_DISABLED';

export function isLivekitDataDisabledError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(LIVEKIT_DATA_DISABLED_CODE);
}

/**
 * Build a `LivekitRoomFactory` that rides Bale's own LiveKit SFU. This is the
 * WebRTC carrier's heart: instead of requiring the user to configure an
 * external LiveKit server (which Iran would block), we call Bale's
 * `Meet.StartCall` to get an access token for Bale's in-network SFU
 * (`wss://meet-*.ble.ir/rtc`), which is whitelisted.
 *
 * The factory encapsulates three asymmetric flows depending on which side is
 * calling it:
 *
 *   - `side='client'`: initiates the call via `StartCall(targetPeer=server)`.
 *     Remembers the resulting call_id so it can hang up cleanly on close.
 *   - `side='server'`: doesn't initiate; it must already know the call_id from
 *     an out-of-band signalling hop (chat message, stream push, …) and joins
 *     the same LiveKit room.
 *
 * The returned `LivekitRoomLike` connects to LiveKit via `livekit-client`
 * (dynamic import so we can still build without that dep installed).
 */
export interface BaleMeetFactoryOptions {
  client: BaleClient;
  /** The Bale peer to call (or to be called by). Client: dials this peer. Server: expects a call FROM this peer. */
  targetPeer: Peer;
  /**
   * How the CALLEE (side='server') learns the incoming call's `callId`. Once
   * it has the id, `makeBaleMeetFactory` calls `client.acceptCall(callId)`
   * itself, which returns the JWT + URL.
   *
   * Options for your signalling:
   *   (a) out-of-band via chat — client sends `__WT_MEET__<callId>` after
   *       StartCall; server parses that; callIdResolver returns it.
   *   (b) in-band listener on the Bale WS — subscribe to the incoming-call
   *       push (tag 0xba 0xe4 0x19); when one arrives, return its callId.
   *
   * If not supplied, the server side throws.
   */
  callIdResolver?: (ctx: LivekitConnectContext) => Promise<bigint>;
  /**
   * Escape hatch for tests / offline replay: if you already have a
   * StartCallResult (e.g. from a pre-captured transcript) you can bypass the
   * RPC plumbing entirely.
   */
  incomingResolver?: (ctx: LivekitConnectContext) => Promise<StartCallResult>;
  /**
   * CLIENT-side hook: fires immediately after `Meet.StartCall` returns, BEFORE
   * the LiveKit connection is opened. Use this to chat-signal the callee with
   * `buildMeetOffer(result.callId)` so it can AcceptCall.
   */
  onCallerStarted?: (result: StartCallResult) => Promise<void> | void;
}

export function makeBaleMeetFactory(opts: BaleMeetFactoryOptions): LivekitRoomFactory {
  return async (ctx) => {
    let call: StartCallResult;
    if (ctx.side === 'client') {
      call = await opts.client.startCall(opts.targetPeer);
      if (opts.onCallerStarted) {
        try { await opts.onCallerStarted(call); } catch { /* signalling best-effort */ }
      }
    } else if (opts.incomingResolver) {
      // Direct-inject path (used by tests / offline).
      call = await opts.incomingResolver(ctx);
    } else if (opts.callIdResolver) {
      // Signalling-aware path: wait for callId, then accept via Bale.
      const callId = await opts.callIdResolver(ctx);
      // Best-effort ReceiveCall so the other party sees "ringing", then Accept.
      try { await opts.client.receiveCall(callId); } catch { /* non-fatal */ }
      call = await opts.client.acceptCall(callId);
    } else {
      throw new Error(
        'BaleMeetFactory: server side requires callIdResolver (reads the callId from your signalling channel) or incomingResolver (direct StartCallResult injection).',
      );
    }
    const url = buildLiveKitUrl(call);
    let room: LivekitRoomLike;
    try {
      room = await connectLivekitRoom(url, ctx);
    } catch (e) {
      if (ctx.side === 'client') {
        try { await opts.client.discardCall(call.callId); } catch { /* best-effort */ }
      }
      throw e;
    }
    // Wrap the teardown so hanging up also tells Bale the call is over.
    const origDisconnect = room.disconnect.bind(room);
    return {
      ...room,
      disconnect: async (reason?: string) => {
        await origDisconnect(reason);
        if (ctx.side === 'client') {
          try { await opts.client.discardCall(call.callId); } catch { /* best-effort */ }
        }
      },
    };
  };
}

/**
 * Convert our serialized Bale/LiveKit URL bundle into the connect arguments
 * expected by the LiveKit SDK.
 *
 * Historically `buildLiveKitUrl()` appended `/rtc` itself, which is wrong for
 * both `@livekit/rtc-node` and `livekit-client`: `Room.connect()` expects the
 * server root and appends `/rtc` / `/rtc/v1` internally. Keep stripping the
 * legacy suffix so older serialized URLs still work.
 */
export function extractLivekitConnectArgs(url: string): { serverUrl: string; token: string } {
  const u = new URL(url);
  const token = u.searchParams.get('access_token') ?? '';
  u.search = '';
  u.hash = '';
  const trimmed = u.pathname.replace(/\/rtc(?:\/v1)?\/?$/i, '').replace(/\/+$/, '');
  const pathname = trimmed === '' ? '/' : trimmed;
  const serverUrl = `${u.protocol}//${u.host}${pathname === '/' ? '' : pathname}`;
  return { serverUrl, token };
}

/**
 * Connect to LiveKit. Tries `@livekit/rtc-node` first (the Node-native SDK
 * with embedded WebRTC — required for Electron's main process, which doesn't
 * have `navigator`/`RTCPeerConnection`), then falls back to `livekit-client`
 * (browser-native; fine when invoked from an Electron renderer).
 *
 * Both SDKs expose the same two call shapes we need: `room.connect(url,
 * token)`, `room.localParticipant.publishData(bytes, opts)`, and the
 * `RoomEvent.DataReceived` / `RoomEvent.Disconnected` events. The only API
 * skew is the `DataReceived` event's argument shape, handled below.
 */
export async function connectLivekitRoom(url: string, ctx: LivekitConnectContext): Promise<LivekitRoomLike> {
  // Variable-name import so TS doesn't complain when the dep is missing
  // at compile time in packages that opt not to bundle either SDK.
  const RTC_NODE = '@livekit/rtc-node';
  const LK_CLIENT = 'livekit-client';
  // Detect a Node.js / Electron main-process runtime. Newer Node versions
  // expose a `navigator`, so key off `process.versions.node` plus no `window`.
  // In that environment livekit-client (browser SDK) cannot work, so we MUST
  // use @livekit/rtc-node — and we want a loud, actionable error if it's not
  // installed instead of silently falling through to livekit-client and
  // exploding deep inside its `isReactNative()` helper.
  const isMainProcess = typeof globalThis !== 'undefined'
    && typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string'
    && typeof (globalThis as { window?: unknown }).window === 'undefined';
  let sdk: any = null;
  let sdkKind: 'node' | 'client' | null = null;
  if (isMainProcess) {
    try {
      sdk = await import(RTC_NODE);
      sdkKind = 'node';
    } catch (eNode) {
      const detail = (eNode as Error)?.stack ?? (eNode as Error)?.message ?? String(eNode);
      // eslint-disable-next-line no-console
      console.error('[livekit] @livekit/rtc-node load failed:', detail);
      throw new Error(
        `Failed to load @livekit/rtc-node (required in Electron main process): ${detail}. ` +
        `If this is a packaged build, the native binding likely wasn't bundled — check ` +
        `electron-builder.yml's files / asarUnpack for @livekit/rtc-node and rtc-ffi-bindings.`,
      );
    }
  } else {
    try {
      sdk = await import(LK_CLIENT);
      sdkKind = 'client';
    } catch (eBrowser) {
      throw new Error(
        `Failed to load livekit-client in renderer/browser context: ${(eBrowser as Error).message}.`,
      );
    }
  }

  const { serverUrl, token } = extractLivekitConnectArgs(url);

  const room = new sdk.Room();
  await room.connect(serverUrl, token, { autoSubscribe: true });
  const permission = logLivekitPermissionSnapshot(room, ctx);
  let mediaCarrier: RtcNodeVideoPacketCarrier | null = null;
  if (permission.canPublishData === false) {
    if (sdkKind !== 'node') {
      try { await room.disconnect(); } catch { /* ignore */ }
      throw new Error(
        `${LIVEKIT_DATA_DISABLED_CODE}: Bale LiveKit joined side=${ctx.side} ` +
        `identity=${permission.identity}, but canPublishData=false. ` +
        `Bale Meet permits media tracks, but this runtime cannot publish a media-backed tunnel.`,
      );
    }
    // Bale still allows media publishing (`canPublish=true`). Use a synthetic
    // video track as the byte carrier when LiveKit's data-packet permission is
    // explicitly disabled.
    mediaCarrier = await makeRtcNodeVideoPacketCarrier(sdk, room, ctx);
    // eslint-disable-next-line no-console
    console.log(`[livekit] using media-video packet carrier side=${ctx.side} identity=${permission.identity}`);
  }

  const dataHandlers = new Set<(bytes: Uint8Array, fromIdentity: string) => void>();
  const discHandlers = new Set<(reason: string) => void>();

  if (sdkKind === 'node') {
    // @livekit/rtc-node fires DataReceived with a single DataPacket object that has
    // {payload, participant, kind, topic}.
    room.on('dataReceived' as any, (packet: any) => {
      const payload: Uint8Array = packet?.payload ?? packet?.data ?? packet;
      const identity: string = packet?.participant?.identity ?? 'unknown';
      for (const cb of dataHandlers) cb(payload, identity);
    });
    room.on('disconnected' as any, (reason?: unknown) => {
      const msg = typeof reason === 'string' ? reason : 'disconnected';
      for (const cb of discHandlers) cb(msg);
    });
  } else {
    // livekit-client fires DataReceived with (payload, participant, kind, topic).
    room.on(sdk.RoomEvent.DataReceived, (payload: Uint8Array, participant: any) => {
      for (const cb of dataHandlers) cb(payload, participant?.identity ?? 'unknown');
    });
    room.on(sdk.RoomEvent.Disconnected, (reason: unknown) => {
      const msg = typeof reason === 'string' ? reason : 'disconnected';
      for (const cb of discHandlers) cb(msg);
    });
  }

  const surface: LivekitRoomLike = {
    localIdentity: room.localParticipant.identity ?? ctx.identity,
    async publishData(bytes: Uint8Array, opts?: { reliable?: boolean; destinationIdentities?: string[] }) {
      if (mediaCarrier) {
        await mediaCarrier.send(bytes);
        return;
      }
      await room.localParticipant.publishData(bytes, {
        reliable: opts?.reliable ?? true,
        destinationIdentities: opts?.destinationIdentities ?? [],
      });
    },
    onDataReceived(cb: (bytes: Uint8Array, fromIdentity: string) => void) {
      if (mediaCarrier) return mediaCarrier.onMessage(cb);
      dataHandlers.add(cb);
      return () => dataHandlers.delete(cb);
    },
    onDisconnect(cb: (reason: string) => void) {
      discHandlers.add(cb);
      return () => discHandlers.delete(cb);
    },
    async disconnect() {
      await mediaCarrier?.close();
      await room.disconnect();
    },
  };
  return surface;
}

interface LivekitPermissionSnapshot {
  identity: string;
  canPublish: boolean | null;
  canPublishData: boolean | null;
  canSubscribe: boolean | null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function logLivekitPermissionSnapshot(room: any, ctx: LivekitConnectContext): LivekitPermissionSnapshot {
  const localParticipant = room?.localParticipant;
  const permission = localParticipant?.permissions ?? localParticipant?.info?.permission;
  const identity = localParticipant?.identity ?? localParticipant?.info?.identity ?? ctx.identity;
  const snapshot = {
    identity,
    canPublish: readBoolean(permission?.canPublish),
    canPublishData: readBoolean(permission?.canPublishData),
    canSubscribe: readBoolean(permission?.canSubscribe),
  };
  // Keep this visible in logs so future SDK changes are diagnosed from the
  // connected-room state, not just the JWT.
  // eslint-disable-next-line no-console
  console.log(
    `[livekit] connected side=${ctx.side} identity=${identity} ` +
    `canPublish=${snapshot.canPublish ?? 'unknown'} ` +
    `canPublishData=${snapshot.canPublishData ?? 'unknown'} ` +
    `canSubscribe=${snapshot.canSubscribe ?? 'unknown'}`,
  );
  return snapshot;
}
