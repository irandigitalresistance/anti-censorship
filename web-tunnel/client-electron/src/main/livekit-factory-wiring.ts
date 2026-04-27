import {
  makeLocalLivekitRoomFactory,
  type LivekitRoomFactory,
} from '@webtunnel/shared';

/**
 * Build a LiveKit room factory based on environment configuration.
 *
 *   WT_LIVEKIT_MODE=mock   → localhost mock broker, useful for running the
 *                             latest client + server Electron apps together
 *                             on one machine without real LiveKit infra.
 *   WT_LIVEKIT_MODE=real   → use `livekit-client` (dynamic import). Requires
 *                             LIVEKIT_URL and a way to obtain tokens:
 *                               - LIVEKIT_ACCESS_TOKEN (static, single-user)  OR
 *                               - LIVEKIT_API_KEY + LIVEKIT_API_SECRET       (mint on demand)
 *   unset                   → no factory; WebRTC carrier disabled.
 *
 * Returning null cleanly disables the carrier; the controller will surface a
 * clear error if the user picks WebRTC anyway.
 */
export function buildLivekitFactory(): LivekitRoomFactory | null {
  const mode = process.env.WT_LIVEKIT_MODE;
  if (!mode) return null;

  if (mode === 'mock') {
    return makeLocalLivekitRoomFactory();
  }

  if (mode === 'real') {
    return buildRealLivekitFactory();
  }

  throw new Error(`unknown WT_LIVEKIT_MODE: ${mode} (want mock|real)`);
}

function buildRealLivekitFactory(): LivekitRoomFactory {
  const url = process.env.LIVEKIT_URL;
  if (!url) throw new Error('WT_LIVEKIT_MODE=real but LIVEKIT_URL is not set');
  const staticToken = process.env.LIVEKIT_ACCESS_TOKEN;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const hasMinter = apiKey && apiSecret;
  if (!staticToken && !hasMinter) {
    throw new Error(
      'WT_LIVEKIT_MODE=real requires either LIVEKIT_ACCESS_TOKEN or (LIVEKIT_API_KEY + LIVEKIT_API_SECRET)',
    );
  }
  return async (ctx) => {
    // Variable-name import avoids TS trying to resolve these optional deps.
    const LK_CLIENT = 'livekit-client';
    let sdk: any;
    try {
      sdk = await import(LK_CLIENT);
    } catch (e) {
      throw new Error(
        `cannot import 'livekit-client' (install with: pnpm --filter @webtunnel/client-electron add livekit-client): ${(e as Error).message}`,
      );
    }
    const token = staticToken ?? (await mintToken(ctx, apiKey!, apiSecret!));
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

async function mintToken(
  ctx: { side: 'client' | 'server'; roomName: string; identity: string; peerIdentity: string },
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const LK_SERVER = 'livekit-server-sdk';
  let sdk: any;
  try {
    sdk = await import(LK_SERVER);
  } catch (e) {
    throw new Error(
      `cannot import 'livekit-server-sdk' (install with: pnpm --filter @webtunnel/client-electron add livekit-server-sdk): ${(e as Error).message}`,
    );
  }
  const at = new sdk.AccessToken(apiKey, apiSecret, { identity: ctx.identity });
  at.addGrant({ roomJoin: true, room: ctx.roomName, canPublish: true, canSubscribe: true, canPublishData: true });
  return await at.toJwt();
}
