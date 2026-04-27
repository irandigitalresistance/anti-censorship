import {
  TunnelMux,
  TunnelMuxV2,
  clientHandshake,
  clientHandshakeV2,
  type EncodeV2PacketOptions,
  type Transport,
  type V2ClientMetadata,
} from '@webtunnel/shared';

export async function runClientTunnel(transport: Transport, psk: Uint8Array): Promise<TunnelMux> {
  const cipher = await clientHandshake(transport, psk);
  return new TunnelMux({ transport, cipher, role: 'client' });
}

export interface RunClientTunnelV2Options extends EncodeV2PacketOptions {
  onServerIdentity?: (info: { publicKey: Uint8Array; fingerprint: string }) => Promise<void> | void;
  /** Optional client identity (clientType, clientVersion) advertised in the v2 hello. */
  metadata?: V2ClientMetadata;
}

export interface RunClientTunnelV2Result {
  mux: TunnelMuxV2;
  serverFingerprint: string;
  serverPublicKey: Uint8Array;
}

export async function runClientTunnelV2(
  transport: Transport,
  opts: RunClientTunnelV2Options = {},
): Promise<RunClientTunnelV2Result> {
  const hs = await clientHandshakeV2(transport, { metadata: opts.metadata });
  await opts.onServerIdentity?.({
    publicKey: hs.serverPublicKey,
    fingerprint: hs.serverFingerprint,
  });
  const mux = new TunnelMuxV2({
    transport,
    cipher: hs.cipher,
    role: 'client',
    compressionThreshold: opts.compressionThreshold,
    minCompressionSavings: opts.minCompressionSavings,
  });
  return {
    mux,
    serverFingerprint: hs.serverFingerprint,
    serverPublicKey: hs.serverPublicKey,
  };
}
