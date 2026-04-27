import type { Transport } from './transport.js';
import type { OpenAddress } from './open.js';
import { chunkPayload } from './frame.js';
import { SessionCipher } from './handshake.js';
import {
  WT2_FLAG_RELIABLE,
  decodeV2ControlMessage,
  decodeV2LogReport,
  decodeV2Packet,
  encodeV2ControlMessage,
  encodeV2LogReport,
  encodeV2Packet,
  type EncodeV2PacketOptions,
  type V2ControlMessage,
  type V2LogReport,
} from './protocol-v2.js';

export interface V2Stream {
  readonly id: number;
  readonly addr: OpenAddress;
  readonly closed: boolean;
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  close(reason?: string): void;
  onClose(cb: (reason: string) => void): void;
}

interface V2StreamImpl extends V2Stream {
  _deliverData(data: Uint8Array): void;
  _remoteClose(reason: string): void;
}

export interface UdpFlow {
  readonly id: number;
  readonly addr: OpenAddress;
  readonly closed: boolean;
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  close(reason?: string): void;
  onClose(cb: (reason: string) => void): void;
}

interface UdpFlowImpl extends UdpFlow {
  _deliver(data: Uint8Array): void;
  _remoteClose(reason: string): void;
}

export interface TunnelMuxV2Options extends EncodeV2PacketOptions {
  transport: Transport;
  cipher: SessionCipher;
  role: 'client' | 'server';
  maxUdpFlows?: number;
  /**
   * Heartbeat ping interval (ms). Default 5_000. Both sides ping each other —
   * whoever sees `maxMissedPongs` consecutive misses closes the mux. Tight
   * defaults exist because the LiveKit data channel goes silent (~20 s) when
   * nobody is publishing, and we want to detect+reconnect well before that.
   */
  pingIntervalMs?: number;
  /** Close after this many consecutive missed pongs. Default 3 (≈15 s). */
  maxMissedPongs?: number;
  /**
   * If true, do not start the heartbeat. Used by tests / short-lived flows
   * (log upload) where the extra control traffic is unwanted.
   */
  disableHeartbeat?: boolean;
}

export class TunnelMuxV2 {
  private readonly transport: Transport;
  private readonly cipher: SessionCipher;
  private readonly role: 'client' | 'server';
  private readonly encodeOpts: EncodeV2PacketOptions;
  private readonly maxUdpFlows: number;
  private readonly pingIntervalMs: number;
  private readonly maxMissedPongs: number;
  private readonly disableHeartbeat: boolean;
  private readonly streams = new Map<number, V2StreamImpl>();
  private readonly udpFlows = new Map<number, UdpFlowImpl>();
  private nextClientStreamId = 1;
  private nextClientFlowId = 1;
  private closed = false;
  private onStreamHandler: ((stream: V2Stream) => void) | null = null;
  private onUdpFlowHandler: ((flow: UdpFlow) => void) | null = null;
  private onLogHandler: ((report: V2LogReport) => void) | null = null;
  private onTerminateHandler: ((reason: string) => void) | null = null;
  private onCloseHandler: ((reason: string) => void) | null = null;

  /** Pending ping promises: ts -> resolve/reject */
  private readonly pendingPings = new Map<number, { resolve: (rtt: number) => void; reject: (e: Error) => void; sentAt: number }>();
  /** Server-side heartbeat tracking */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private lastPongAt = 0;

  constructor(opts: TunnelMuxV2Options) {
    this.transport = opts.transport;
    this.cipher = opts.cipher;
    this.role = opts.role;
    this.encodeOpts = {
      compressionThreshold: opts.compressionThreshold,
      minCompressionSavings: opts.minCompressionSavings,
    };
    this.maxUdpFlows = Math.max(1, opts.maxUdpFlows ?? 1024);
    this.pingIntervalMs = opts.pingIntervalMs ?? 5_000;
    this.maxMissedPongs = opts.maxMissedPongs ?? 3;
    this.disableHeartbeat = opts.disableHeartbeat ?? false;
    this.transport.onMessage((wire) => this.handleWire(wire));
    this.transport.onClose((reason) => this.shutdown(reason));
    if (!this.disableHeartbeat) {
      // Both sides heartbeat. Whichever side sees N missed pongs closes the
      // mux so the upstream reconnect loop can take over.
      this.startHeartbeat();
    }
  }

  /**
   * Measure round-trip latency by sending a ping and waiting for pong.
   * Returns RTT in milliseconds. Rejects after timeoutMs.
   */
  measurePingRtt(timeoutMs = 5_000): Promise<number> {
    if (this.closed) return Promise.reject(new Error('mux closed'));
    const ts = Date.now();
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(ts);
        reject(new Error(`ping timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingPings.set(ts, {
        sentAt: ts,
        resolve: (rtt) => { clearTimeout(timer); resolve(rtt); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sendControl({ kind: 'ping', ts });
    });
  }

  private startHeartbeat(): void {
    this.lastPongAt = Date.now();
    this.missedPongs = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) {
        this.stopHeartbeat();
        return;
      }
      // If we've gone more than pingIntervalMs without a pong since our last
      // ping, count that as one missed beat. Reset on any pong (handled in
      // handleWire's 'pong' case).
      const sincePong = Date.now() - this.lastPongAt;
      if (sincePong > this.pingIntervalMs) {
        this.missedPongs += 1;
      }
      if (this.missedPongs >= this.maxMissedPongs) {
        this.stopHeartbeat();
        const reason = `keepalive timeout — ${this.missedPongs} missed pongs (${Math.round(sincePong / 1000)}s silent)`;
        this.shutdown(reason);
        try { this.transport.close(reason); } catch { /* ignore */ }
        return;
      }
      try {
        this.sendControl({ kind: 'ping', ts: Date.now() });
      } catch (e) {
        // sendControl can throw if the transport is mid-teardown — treat as miss.
        this.missedPongs += 1;
      }
    }, this.pingIntervalMs);
    if (typeof (this.heartbeatTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.heartbeatTimer as unknown as { unref: () => void }).unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  onStream(cb: (stream: V2Stream) => void): void {
    this.onStreamHandler = cb;
  }

  onUdpFlow(cb: (flow: UdpFlow) => void): void {
    this.onUdpFlowHandler = cb;
  }

  onLog(cb: (report: V2LogReport) => void): void {
    this.onLogHandler = cb;
  }

  onTerminate(cb: (reason: string) => void): void {
    this.onTerminateHandler = cb;
  }

  onClose(cb: (reason: string) => void): void {
    this.onCloseHandler = cb;
  }

  openStream(addr: OpenAddress): V2Stream {
    if (this.role !== 'client') throw new Error('openStream is client-only');
    if (this.closed) throw new Error('mux closed');
    const id = this.nextClientStreamId;
    this.nextClientStreamId += 2;
    const stream = this.createStream(id, addr);
    this.streams.set(id, stream);
    this.sendControl({ kind: 'tcp-open', streamId: id, addr });
    return stream;
  }

  openUdpFlow(addr: OpenAddress): UdpFlow {
    if (this.role !== 'client') throw new Error('openUdpFlow is client-only');
    if (this.closed) throw new Error('mux closed');
    if (this.udpFlows.size >= this.maxUdpFlows) {
      throw new Error(`too many udp flows (max ${this.maxUdpFlows})`);
    }
    const id = this.nextClientFlowId;
    this.nextClientFlowId += 2;
    const flow = this.createUdpFlow(id, addr);
    this.udpFlows.set(id, flow);
    this.sendControl({ kind: 'udp-open', flowId: id, addr });
    return flow;
  }

  sendLogReport(report: V2LogReport): void {
    if (this.closed) return;
    this.sendPacket('log', 0, encodeV2LogReport(report), WT2_FLAG_RELIABLE);
  }

  terminate(reason: string): void {
    this.sendControl({ kind: 'terminate', reason });
    this.shutdown(`terminated: ${reason}`);
    this.transport.close(`terminated: ${reason}`);
  }

  close(reason = 'mux-v2 closed'): void {
    this.shutdown(reason);
    this.transport.close(reason);
  }

  private sendControl(message: V2ControlMessage): void {
    this.sendPacket('control', 0, encodeV2ControlMessage(message), WT2_FLAG_RELIABLE);
  }

  private sendPacket(type: 'control' | 'tcp' | 'udp' | 'log', channelId: number, payload: Uint8Array, flags = 0): void {
    if (this.closed) return;
    const wire = encodeV2Packet({ type, channelId, payload, flags }, this.encodeOpts);
    const encrypted = this.cipher.encrypt(wire);
    void this.transport.send(encrypted);
  }

  private handleWire(wire: Uint8Array): void {
    if (this.closed) return;
    let plain: Uint8Array;
    try {
      plain = this.cipher.decrypt(wire);
    } catch {
      const reason = 'decryption failed: possible network corruption or key mismatch';
      this.shutdown(reason);
      try { this.transport.close(reason); } catch { /* ignore */ }
      return;
    }
    let packet;
    try {
      packet = decodeV2Packet(plain);
    } catch {
      const reason = 'received malformed data from peer';
      this.shutdown(reason);
      try { this.transport.close(reason); } catch { /* ignore */ }
      return;
    }
    switch (packet.type) {
      case 'control':
        this.handleControl(packet.payload);
        return;
      case 'tcp': {
        const stream = this.streams.get(packet.channelId);
        if (!stream) return;
        stream._deliverData(packet.payload);
        return;
      }
      case 'udp': {
        const flow = this.udpFlows.get(packet.channelId);
        if (!flow) return;
        flow._deliver(packet.payload);
        return;
      }
      case 'log':
        try {
          this.onLogHandler?.(decodeV2LogReport(packet.payload));
        } catch {
          // ignore malformed log packet
        }
        return;
    }
  }

  private handleControl(payload: Uint8Array): void {
    let msg: V2ControlMessage;
    try {
      msg = decodeV2ControlMessage(payload);
    } catch {
      this.shutdown('v2 control decode failed');
      return;
    }
    switch (msg.kind) {
      case 'tcp-open': {
        if (this.role !== 'server') return;
        if (this.streams.has(msg.streamId)) return;
        const stream = this.createStream(msg.streamId, msg.addr);
        this.streams.set(msg.streamId, stream);
        this.onStreamHandler?.(stream);
        return;
      }
      case 'tcp-close': {
        const stream = this.streams.get(msg.streamId);
        if (!stream) return;
        stream._remoteClose(msg.reason ?? 'remote close');
        return;
      }
      case 'udp-open': {
        if (this.role !== 'server') return;
        if (this.udpFlows.has(msg.flowId)) return;
        if (this.udpFlows.size >= this.maxUdpFlows) {
          this.sendControl({
            kind: 'udp-close',
            flowId: msg.flowId,
            reason: `too many udp flows (max ${this.maxUdpFlows})`,
          });
          return;
        }
        const flow = this.createUdpFlow(msg.flowId, msg.addr);
        this.udpFlows.set(msg.flowId, flow);
        this.onUdpFlowHandler?.(flow);
        return;
      }
      case 'udp-close': {
        const flow = this.udpFlows.get(msg.flowId);
        if (!flow) return;
        flow._remoteClose(msg.reason ?? 'remote close');
        return;
      }
      case 'terminate': {
        this.onTerminateHandler?.(msg.reason);
        this.shutdown(`terminated: ${msg.reason}`);
        return;
      }
      case 'ping': {
        this.sendControl({ kind: 'pong', ts: msg.ts });
        return;
      }
      case 'pong': {
        this.lastPongAt = Date.now();
        this.missedPongs = 0;
        const pending = this.pendingPings.get(msg.ts);
        if (pending) {
          this.pendingPings.delete(msg.ts);
          pending.resolve(Date.now() - pending.sentAt);
        }
        return;
      }
    }
  }

  private createStream(id: number, addr: OpenAddress): V2StreamImpl {
    const dataHandlers: Array<(data: Uint8Array) => void> = [];
    const closeHandlers: Array<(reason: string) => void> = [];
    let streamClosed = false;
    const stream: V2StreamImpl = {
      id,
      addr,
      get closed() {
        return streamClosed;
      },
      write: (data) => {
        if (streamClosed || this.closed) return;
        for (const chunk of chunkPayload(data)) {
          this.sendPacket('tcp', id, chunk, WT2_FLAG_RELIABLE);
        }
      },
      onData: (cb) => {
        dataHandlers.push(cb);
      },
      close: (reason = 'local close') => {
        if (streamClosed) return;
        streamClosed = true;
        this.streams.delete(id);
        this.sendControl({ kind: 'tcp-close', streamId: id, reason });
        for (const cb of closeHandlers) cb(reason);
      },
      onClose: (cb) => {
        closeHandlers.push(cb);
      },
      _deliverData: (data) => {
        for (const cb of dataHandlers) cb(data);
      },
      _remoteClose: (reason) => {
        if (streamClosed) return;
        streamClosed = true;
        this.streams.delete(id);
        for (const cb of closeHandlers) cb(reason);
      },
    };
    return stream;
  }

  private createUdpFlow(id: number, addr: OpenAddress): UdpFlowImpl {
    const messageHandlers: Array<(data: Uint8Array) => void> = [];
    const closeHandlers: Array<(reason: string) => void> = [];
    let flowClosed = false;
    const flow: UdpFlowImpl = {
      id,
      addr,
      get closed() {
        return flowClosed;
      },
      send: (data) => {
        if (flowClosed || this.closed) return;
        this.sendPacket('udp', id, data, 0);
      },
      onMessage: (cb) => {
        messageHandlers.push(cb);
      },
      close: (reason = 'local close') => {
        if (flowClosed) return;
        flowClosed = true;
        this.udpFlows.delete(id);
        this.sendControl({ kind: 'udp-close', flowId: id, reason });
        for (const cb of closeHandlers) cb(reason);
      },
      onClose: (cb) => {
        closeHandlers.push(cb);
      },
      _deliver: (data) => {
        for (const cb of messageHandlers) cb(data);
      },
      _remoteClose: (reason) => {
        if (flowClosed) return;
        flowClosed = true;
        this.udpFlows.delete(id);
        for (const cb of closeHandlers) cb(reason);
      },
    };
    return flow;
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    for (const pending of this.pendingPings.values()) {
      pending.reject(new Error(`mux closed: ${reason}`));
    }
    this.pendingPings.clear();
    for (const stream of this.streams.values()) {
      stream._remoteClose(reason);
    }
    this.streams.clear();
    for (const flow of this.udpFlows.values()) {
      flow._remoteClose(reason);
    }
    this.udpFlows.clear();
    this.onCloseHandler?.(reason);
  }
}
