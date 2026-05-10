import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { OpenAddress } from '@webtunnel/shared';

export interface TunnelPeerSummary {
  chatId: number;
  chatType: string;
  name: string | null;
  username: string | null;
}

export interface TunnelSummary {
  id: string;
  label: string;
  carrier: string | null;
  protocolVersion: number | null;
  peer: TunnelPeerSummary | null;
  /** OS family the connecting client identified as ('windows' | 'android' | other). */
  clientType: string | null;
  /** Free-form client version string, e.g. '0.2.0'. */
  clientVersion: string | null;
  /** Managed config client id. Null means an older Bale-account client. */
  clientId: string | null;
  /** Human-readable managed client name created on the server. */
  clientName: string | null;
  /** managed = server-issued config; legacy = Bale-account client. */
  clientKind: 'managed' | 'legacy' | null;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
  terminable: boolean;
  terminationState: 'idle' | 'terminating' | 'terminated' | 'failed';
  streamsOpened: number;
  streamsActive: number;
  bytesUp: number;
  bytesDown: number;
}

export interface TunnelSnapshot extends TunnelSummary {
  streams: StreamSummary[];
}

export interface StreamSummary {
  streamId: number;
  addr: OpenAddress;
  openedAt: number;
  closedAt: number | null;
  bytesUp: number;
  bytesDown: number;
}

export interface MetricsTick {
  ts: number;
  perTunnel: Record<string, { bytesUpDelta: number; bytesDownDelta: number; streamsActive: number }>;
  /**
   * Cumulative bytes since this manager was constructed (or last loaded from
   * persistent storage). MONOTONIC — never decreases when tunnels close.
   */
  lifetimeBytesUp: number;
  lifetimeBytesDown: number;
}

/**
 * Per-user (per-Bale-account) cumulative byte counters. The user record is
 * KEYED on `${chatType}:${chatId}` — never deleted, only zero'd via reset.
 * That guarantees the operator can always see every account that has ever
 * connected, even if they have no active tunnels right now.
 */
export interface UserStats {
  peerKey: string;
  chatId: number;
  chatType: string;
  name: string | null;
  username: string | null;
  bytesUp: number;
  bytesDown: number;
  /** Seconds-precision timestamp of the first ever observation. */
  firstSeen: number;
  /** Seconds-precision timestamp of the most recent byte observation. */
  lastSeen: number;
}

interface TunnelState {
  summary: TunnelSummary;
  streams: Map<number, StreamSummary>;
  terminator: ((reason: string) => void | Promise<void>) | null;
  lastBytesUp: number;
  lastBytesDown: number;
}

export interface TunnelMeta {
  carrier?: string | null;
  peer?: TunnelPeerSummary | null;
  protocolVersion?: number | null;
  terminable?: boolean;
  clientType?: string | null;
  clientVersion?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  clientKind?: 'managed' | 'legacy' | null;
}

export interface TunnelUpdate {
  label?: string;
  carrier?: string | null;
  peer?: TunnelPeerSummary | null;
  protocolVersion?: number | null;
  terminable?: boolean;
  terminationState?: 'idle' | 'terminating' | 'terminated' | 'failed';
  clientType?: string | null;
  clientVersion?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  clientKind?: 'managed' | 'legacy' | null;
}

/**
 * Tracks active tunnels and their per-tunnel metrics. Dashboard subscribes via events.
 *
 * Events:
 *   - 'tunnel-opened' (TunnelSnapshot)
 *   - 'tunnel-updated' (TunnelSnapshot)
 *   - 'tunnel-closed' (TunnelSnapshot)
 *   - 'stream-opened' ({ tunnelId, stream: StreamSummary })
 *   - 'stream-closed' ({ tunnelId, streamId })
 *   - 'metrics-tick' (MetricsTick)
 */
export class TunnelManager extends EventEmitter {
  private readonly tunnels = new Map<string, TunnelState>();
  private readonly users = new Map<string, UserStats>();
  private tickTimer: NodeJS.Timeout | null = null;
  private lifetimeBytesUp = 0;
  private lifetimeBytesDown = 0;

  constructor(private readonly tickIntervalMs = 1000) {
    super();
  }

  /** Seed cumulative counters from persisted storage (server restart). */
  loadLifetime(snapshot: { up: number; down: number }): void {
    this.lifetimeBytesUp = Math.max(0, Math.floor(snapshot.up));
    this.lifetimeBytesDown = Math.max(0, Math.floor(snapshot.down));
  }

  /** Read the monotonic cumulative byte counter. */
  getLifetime(): { up: number; down: number } {
    return { up: this.lifetimeBytesUp, down: this.lifetimeBytesDown };
  }

  /** Seed per-user stats from persistent storage on startup. */
  loadUserStats(stats: Iterable<UserStats>): void {
    this.users.clear();
    for (const u of stats) {
      if (!u || typeof u.peerKey !== 'string') continue;
      this.users.set(u.peerKey, {
        peerKey: u.peerKey,
        chatId: u.chatId,
        chatType: u.chatType,
        name: u.name ?? null,
        username: u.username ?? null,
        bytesUp: Math.max(0, Math.floor(u.bytesUp ?? 0)),
        bytesDown: Math.max(0, Math.floor(u.bytesDown ?? 0)),
        firstSeen: u.firstSeen ?? Date.now(),
        lastSeen: u.lastSeen ?? Date.now(),
      });
    }
  }

  /** Snapshot of every user we've ever seen, sorted by lastSeen desc. */
  listUsers(): UserStats[] {
    return Array.from(this.users.values())
      .map((u) => ({ ...u }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Zero out a user's bytes but keep them in the list. Returns false if unknown. */
  resetUser(peerKey: string): boolean {
    const u = this.users.get(peerKey);
    if (!u) return false;
    u.bytesUp = 0;
    u.bytesDown = 0;
    u.lastSeen = Date.now();
    this.emit('user-updated', { ...u });
    return true;
  }

  private touchUser(meta: TunnelMeta | TunnelUpdate): UserStats | null {
    const peer = meta.peer;
    if (!peer || typeof peer.chatId !== 'number') return null;
    const peerKey = `${peer.chatType}:${peer.chatId}`;
    let u = this.users.get(peerKey);
    const now = Date.now();
    if (!u) {
      u = {
        peerKey,
        chatId: peer.chatId,
        chatType: peer.chatType,
        name: peer.name ?? null,
        username: peer.username ?? null,
        bytesUp: 0,
        bytesDown: 0,
        firstSeen: now,
        lastSeen: now,
      };
      this.users.set(peerKey, u);
      this.emit('user-updated', { ...u });
    } else {
      // Update name/username if they got resolved later.
      let changed = false;
      if (peer.name && peer.name !== u.name) { u.name = peer.name; changed = true; }
      if (peer.username && peer.username !== u.username) { u.username = peer.username; changed = true; }
      if (changed) this.emit('user-updated', { ...u });
    }
    return u;
  }

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  snapshot(): TunnelSnapshot[] {
    return Array.from(this.tunnels.values()).map((state) => cloneTunnelSnapshot(state));
  }

  openTunnel(label: string, meta: TunnelMeta = {}): { id: string; close: (reason: string) => void; handle: TunnelHandle } {
    const id = randomUUID();
    const openedAt = Date.now();
    const summary: TunnelSummary = {
      id,
      label,
      carrier: meta.carrier ?? null,
      protocolVersion: meta.protocolVersion ?? null,
      peer: meta.peer ? clonePeer(meta.peer) : null,
      clientType: meta.clientType ?? null,
      clientVersion: meta.clientVersion ?? null,
      clientId: meta.clientId ?? null,
      clientName: meta.clientName ?? null,
      clientKind: meta.clientKind ?? null,
      openedAt,
      closedAt: null,
      closeReason: null,
      terminable: meta.terminable ?? false,
      terminationState: 'idle',
      streamsOpened: 0,
      streamsActive: 0,
      bytesUp: 0,
      bytesDown: 0,
    };
    const state: TunnelState = { summary, streams: new Map(), terminator: null, lastBytesUp: 0, lastBytesDown: 0 };
    this.tunnels.set(id, state);
    // Make sure the user is in the persistent user map even before any bytes
    // flow — otherwise a connection that never moves data wouldn't surface in
    // the user list.
    this.touchUser(meta);
    this.emit('tunnel-opened', cloneTunnelSnapshot(state));
    const close = (reason: string): void => {
      if (state.summary.closedAt != null) return;
      state.summary.closedAt = Date.now();
      state.summary.closeReason = reason;
      if (state.summary.terminationState === 'terminating') {
        state.summary.terminationState = 'terminated';
      }
      this.emit('tunnel-closed', cloneTunnelSnapshot(state));
      this.tunnels.delete(id);
    };
    const handle: TunnelHandle = {
      id,
      openStream: (streamId, addr) => {
        const s: StreamSummary = {
          streamId,
          addr,
          openedAt: Date.now(),
          closedAt: null,
          bytesUp: 0,
          bytesDown: 0,
        };
        state.streams.set(streamId, s);
        state.summary.streamsOpened += 1;
        state.summary.streamsActive += 1;
        this.emit('stream-opened', { tunnelId: id, stream: cloneStream(s) });
      },
      addBytes: (streamId, dir, n) => {
        const s = state.streams.get(streamId);
        if (!s) return;
        if (dir === 'up') {
          s.bytesUp += n;
          state.summary.bytesUp += n;
          this.lifetimeBytesUp += n;
        } else {
          s.bytesDown += n;
          state.summary.bytesDown += n;
          this.lifetimeBytesDown += n;
        }
        // Roll the bytes up to the user record so the operator sees per-user
        // totals even after the tunnel closes.
        if (state.summary.peer) {
          const peerKey = `${state.summary.peer.chatType}:${state.summary.peer.chatId}`;
          const u = this.users.get(peerKey);
          if (u) {
            if (dir === 'up') u.bytesUp += n;
            else u.bytesDown += n;
            u.lastSeen = Date.now();
          }
        }
      },
      closeStream: (streamId) => {
        const s = state.streams.get(streamId);
        if (!s || s.closedAt != null) return;
        s.closedAt = Date.now();
        state.summary.streamsActive = Math.max(0, state.summary.streamsActive - 1);
        state.streams.delete(streamId);
        this.emit('stream-closed', { tunnelId: id, streamId, stream: cloneStream(s) });
      },
      setTerminator: (terminator) => {
        state.terminator = terminator;
      },
      setTerminable: (terminable) => {
        state.summary.terminable = terminable;
        this.emit('tunnel-updated', cloneTunnelSnapshot(state));
      },
      setProtocolVersion: (protocolVersion) => {
        state.summary.protocolVersion = protocolVersion;
        this.emit('tunnel-updated', cloneTunnelSnapshot(state));
      },
      setTerminationState: (terminationState) => {
        state.summary.terminationState = terminationState;
        this.emit('tunnel-updated', cloneTunnelSnapshot(state));
      },
      setClientInfo: (clientType, clientVersion) => {
        state.summary.clientType = clientType;
        state.summary.clientVersion = clientVersion;
        this.emit('tunnel-updated', cloneTunnelSnapshot(state));
      },
    };
    return { id, close, handle };
  }

  updateTunnel(id: string, patch: TunnelUpdate): void {
    const state = this.tunnels.get(id);
    if (!state) return;
    if (patch.label !== undefined) state.summary.label = patch.label;
    if (patch.carrier !== undefined) state.summary.carrier = patch.carrier;
    if (patch.peer !== undefined) state.summary.peer = patch.peer ? clonePeer(patch.peer) : null;
    if (patch.protocolVersion !== undefined) state.summary.protocolVersion = patch.protocolVersion;
    if (patch.terminable !== undefined) state.summary.terminable = patch.terminable;
    if (patch.terminationState !== undefined) state.summary.terminationState = patch.terminationState;
    if (patch.clientType !== undefined) state.summary.clientType = patch.clientType;
    if (patch.clientVersion !== undefined) state.summary.clientVersion = patch.clientVersion;
    if (patch.clientId !== undefined) state.summary.clientId = patch.clientId;
    if (patch.clientName !== undefined) state.summary.clientName = patch.clientName;
    if (patch.clientKind !== undefined) state.summary.clientKind = patch.clientKind;
    // If the dispatcher resolved the peer's name later, refresh the user
    // record so the dashboard label catches up.
    if (patch.peer !== undefined) this.touchUser(patch);
    this.emit('tunnel-updated', cloneTunnelSnapshot(state));
  }

  async terminateTunnel(id: string, reason: string): Promise<boolean> {
    const state = this.tunnels.get(id);
    if (!state) return false;
    if (!state.summary.terminable || !state.terminator) return false;
    state.summary.terminationState = 'terminating';
    this.emit('tunnel-updated', cloneTunnelSnapshot(state));
    try {
      await state.terminator(reason);
      if (state.summary.closedAt == null) {
        state.summary.terminationState = 'terminated';
        this.emit('tunnel-updated', cloneTunnelSnapshot(state));
      }
      return true;
    } catch {
      state.summary.terminationState = 'failed';
      this.emit('tunnel-updated', cloneTunnelSnapshot(state));
      return false;
    }
  }

  private tick(): void {
    const perTunnel: MetricsTick['perTunnel'] = {};
    let anyTraffic = false;
    for (const [id, state] of this.tunnels) {
      const up = state.summary.bytesUp;
      const down = state.summary.bytesDown;
      const upDelta = up - state.lastBytesUp;
      const downDelta = down - state.lastBytesDown;
      state.lastBytesUp = up;
      state.lastBytesDown = down;
      perTunnel[id] = {
        bytesUpDelta: upDelta,
        bytesDownDelta: downDelta,
        streamsActive: state.summary.streamsActive,
      };
      if (upDelta > 0 || downDelta > 0) anyTraffic = true;
    }
    // Always emit so the dashboard sees the lifetime counter even when no
    // tunnel is currently active. Skip only when nothing exists at all.
    if (this.tunnels.size === 0 && !anyTraffic) return;
    this.emit('metrics-tick', {
      ts: Date.now(),
      perTunnel,
      lifetimeBytesUp: this.lifetimeBytesUp,
      lifetimeBytesDown: this.lifetimeBytesDown,
    } as MetricsTick);
  }
}

export interface TunnelHandle {
  id: string;
  openStream(streamId: number, addr: OpenAddress): void;
  addBytes(streamId: number, dir: 'up' | 'down', n: number): void;
  closeStream(streamId: number): void;
  setTerminator(terminate: (reason: string) => void | Promise<void>): void;
  setTerminable(terminable: boolean): void;
  setProtocolVersion(protocolVersion: number | null): void;
  setTerminationState(state: 'idle' | 'terminating' | 'terminated' | 'failed'): void;
  setClientInfo(clientType: string | null, clientVersion: string | null): void;
}

function cloneStream(stream: StreamSummary): StreamSummary {
  return {
    streamId: stream.streamId,
    addr: { ...stream.addr },
    openedAt: stream.openedAt,
    closedAt: stream.closedAt,
    bytesUp: stream.bytesUp,
    bytesDown: stream.bytesDown,
  };
}

function clonePeer(peer: TunnelPeerSummary): TunnelPeerSummary {
  return {
    chatId: peer.chatId,
    chatType: peer.chatType,
    name: peer.name,
    username: peer.username,
  };
}

function cloneTunnelSnapshot(state: TunnelState): TunnelSnapshot {
  return {
    ...state.summary,
    peer: state.summary.peer ? clonePeer(state.summary.peer) : null,
    streams: Array.from(state.streams.values())
      .map((stream) => cloneStream(stream))
      .sort((a, b) => a.openedAt - b.openedAt),
  };
}
