import {
  TunnelMux,
  TunnelMuxV2,
  serverHandshake,
  serverHandshakeV2,
  type EncodeV2PacketOptions,
  type Transport,
  type V2LogReport,
  type V2ServerIdentity,
} from '@webtunnel/shared';
import { bindEgress, bindUdpEgress } from './egress.js';
import type { TunnelHandle } from './dashboard/manager.js';

export interface TunnelMetrics {
  streamsOpened: number;
  bytesUp: number;
  bytesDown: number;
}

export interface RunServerTunnelOptions {
  onMetrics?: (m: TunnelMetrics) => void;
  handle?: TunnelHandle;
}

export async function runServerTunnel(
  transport: Transport,
  psk: Uint8Array,
  opts: RunServerTunnelOptions = {},
): Promise<TunnelMux> {
  const cipher = await serverHandshake(transport, psk);
  const mux = new TunnelMux({ transport, cipher, role: 'server' });
  opts.handle?.setProtocolVersion(1);
  opts.handle?.setTerminable(false);
  opts.handle?.setTerminationState('idle');
  const metrics: TunnelMetrics = { streamsOpened: 0, bytesUp: 0, bytesDown: 0 };
  mux.onStream((stream) => {
    try {
      metrics.streamsOpened += 1;
      opts.handle?.openStream(stream.id, stream.addr);
      stream.onClose(() => {
        try { opts.handle?.closeStream(stream.id); } catch (e) {
          console.warn('[tunnel] closeStream handler failed:', (e as Error).message);
        }
      });
      bindEgress(stream, (dir, n) => {
        try {
          if (dir === 'up') metrics.bytesUp += n;
          else metrics.bytesDown += n;
          opts.handle?.addBytes(stream.id, dir, n);
          opts.onMetrics?.(metrics);
        } catch (e) {
          console.warn('[tunnel] bytes handler failed:', (e as Error).message);
        }
      });
      try { opts.onMetrics?.(metrics); } catch { /* ignore */ }
    } catch (e) {
      console.warn('[tunnel] onStream handler failed:', (e as Error).message);
    }
  });
  return mux;
}

export interface RunServerTunnelV2Options extends RunServerTunnelOptions, EncodeV2PacketOptions {
  identity: V2ServerIdentity;
  onLogReport?: (report: V2LogReport, tunnelId: string | null) => void;
}

export interface RunServerTunnelV2Result {
  mux: TunnelMuxV2;
  terminate: (reason: string) => void;
}

export async function runServerTunnelV2(
  transport: Transport,
  opts: RunServerTunnelV2Options,
): Promise<RunServerTunnelV2Result> {
  const hs = await serverHandshakeV2(transport, opts.identity);
  if (hs.clientMetadata) {
    const ct = typeof hs.clientMetadata.clientType === 'string' ? hs.clientMetadata.clientType : null;
    const cv = typeof hs.clientMetadata.clientVersion === 'string' ? hs.clientMetadata.clientVersion : null;
    if (opts.handle && (ct || cv)) {
      try { opts.handle.setClientInfo(ct, cv); } catch { /* ignore */ }
    }
  }
  const mux = new TunnelMuxV2({
    transport,
    cipher: hs.cipher,
    role: 'server',
    compressionThreshold: opts.compressionThreshold,
    minCompressionSavings: opts.minCompressionSavings,
  });
  const metrics: TunnelMetrics = { streamsOpened: 0, bytesUp: 0, bytesDown: 0 };
  mux.onStream((stream) => {
    try {
      metrics.streamsOpened += 1;
      opts.handle?.openStream(stream.id, stream.addr);
      stream.onClose(() => {
        try { opts.handle?.closeStream(stream.id); } catch (e) {
          console.warn('[tunnel-v2] closeStream handler failed:', (e as Error).message);
        }
      });
      bindEgress(stream, (dir, n) => {
        try {
          if (dir === 'up') metrics.bytesUp += n;
          else metrics.bytesDown += n;
          opts.handle?.addBytes(stream.id, dir, n);
          opts.onMetrics?.(metrics);
        } catch (e) {
          console.warn('[tunnel-v2] bytes handler failed:', (e as Error).message);
        }
      });
      try { opts.onMetrics?.(metrics); } catch { /* ignore */ }
    } catch (e) {
      console.warn('[tunnel-v2] onStream handler failed:', (e as Error).message);
    }
  });
  mux.onLog((report) => {
    try {
      opts.onLogReport?.(report, opts.handle?.id ?? null);
    } catch (e) {
      console.warn('[tunnel-v2] onLog handler failed:', (e as Error).message);
    }
  });
  mux.onUdpFlow((flow) => {
    try {
      bindUdpEgress(flow, {
        onBytes: (dir, n) => {
          try {
            if (dir === 'up') metrics.bytesUp += n;
            else metrics.bytesDown += n;
            opts.onMetrics?.(metrics);
          } catch (e) {
            console.warn('[tunnel-v2] udp bytes handler failed:', (e as Error).message);
          }
        },
      });
    } catch (e) {
      console.warn('[tunnel-v2] onUdpFlow handler failed:', (e as Error).message);
    }
  });
  const terminate = (reason: string): void => {
    mux.terminate(reason);
  };
  if (opts.handle && 'setTerminator' in opts.handle && typeof opts.handle.setTerminator === 'function') {
    opts.handle.setTerminator(terminate);
  }
  if (opts.handle && 'setProtocolVersion' in opts.handle && typeof opts.handle.setProtocolVersion === 'function') {
    opts.handle.setProtocolVersion(2);
  }
  if (opts.handle && 'setTerminable' in opts.handle && typeof opts.handle.setTerminable === 'function') {
    opts.handle.setTerminable(true);
  }
  if (opts.handle && 'setTerminationState' in opts.handle && typeof opts.handle.setTerminationState === 'function') {
    opts.handle.setTerminationState('idle');
  }
  return { mux, terminate };
}
