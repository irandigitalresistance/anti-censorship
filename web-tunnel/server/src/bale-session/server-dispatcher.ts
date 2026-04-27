import {
  BalePeerType,
  buildFrameMessage,
  buildFrameMessageV2,
  makeLivekitTransport,
  parseMagic,
  type V2LogReport,
  type V2ServerIdentity,
  type BaleClient,
  type IncomingCallSource,
  type IncomingMessage,
  type ISidecar,
  type LivekitRoomFactory,
  type Peer,
  type StartCallResult,
  type Transport,
} from '@webtunnel/shared';
import { runServerTunnel, runServerTunnelV2 } from '../tunnel.js';
import type { TunnelHandle, TunnelManager, TunnelPeerSummary } from '../dashboard/manager.js';

interface PerPeerTunnel {
  transport: PassiveTransport;
  startedAt: number;
  closed: boolean;
  sessionTag: string | null;
}

/** Maps meetKey(callId) -> tunnelId for active meet calls so we can update peer after late meet-offer arrives */
type MeetTunnelEntry = { tunnelId: string; effectivePeer: Peer | null };

/**
 * Dispatches incoming Bale chat messages to a per-peer `Transport`. For each
 * new private-chat peer that sends us a `__WT_FRAME__` message, we spin up a
 * fresh server-side tunnel (handshake + mux + egress). Anyone who knows the
 * PSK can complete the handshake; anyone who doesn't gets a decrypt failure
 * and the tunnel tears down.
 */
export class BaleServerDispatcher {
  private static readonly DEFAULT_ZERO_TRANSFER_TIMEOUT_MS = 60_000;
  // WebRTC tunnels have transport-level pong keepalive (~5 min), so a
  // byte-idle timeout shorter than that kills healthy but idle VPN sessions.
  /**
   * How long a webrtc tunnel can sit at zero-bytes-transferred before we
   * tear it down. Was 5 min in v0.0.x; tightened to 60 s for v0.2 because
   * stalled tunnels were appearing as `[unknown client]` ghosts in the
   * dashboard until they timed out. Real handshakes complete in <12 s, so
   * 60 s leaves plenty of slack while still keeping the dashboard clean.
   */
  private static readonly DEFAULT_MEET_ZERO_TRANSFER_TIMEOUT_MS = 60_000;
  /**
   * Hard cap on the v2 handshake itself. If the client doesn't complete
   * within this window the tunnel handle is closed and removed from the
   * dashboard. Prevents `[unknown client]` ghosts when a client connects
   * to LiveKit and then never sends a hello.
   */
  private static readonly HANDSHAKE_HARD_TIMEOUT_MS = 15_000;
  private readonly tunnels = new Map<string, PerPeerTunnel>();
  private readonly activeMeetCalls = new Set<string>();
  private readonly activeMeetTunnels = new Map<string, MeetTunnelEntry>();
  private readonly pendingMeetOffers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly meetOfferPeers = new Map<string, Peer>();
  private offMessage: (() => void) | null = null;
  private offIncomingCall: (() => void) | null = null;
  private startedAtMs: number | null = null;

  constructor(
    private readonly sidecar: ISidecar,
    private readonly psk: Uint8Array,
    private readonly manager: TunnelManager,
    private readonly opts: {
      logger?: (line: string) => void;
      allowChatTypes?: ReadonlyArray<Peer['chatType']>;
      /**
       * Optional: BaleClient for the server's own account. If set, the
       * dispatcher can handle `__WT_MEET__<callId>` chat offers by calling
       * `client.acceptCall(callId)` and spinning up a webrtc-carried tunnel
       * in parallel with any chat-carried tunnels.
       */
      baleClient?: BaleClient;
      /**
       * Optional: `LivekitRoomFactory` used to actually open the LiveKit room
       * after AcceptCall resolves. Defaults to a factory that wraps
       * `livekit-client`. Tests inject a mock factory.
       */
      livekitFactory?: LivekitRoomFactory;
      /** Optional direct Bale incoming-call push source for real Meet accept. */
      incomingCallSource?: IncomingCallSource;
      /** Optional hook to refresh the Bale incoming-call watcher before fallback accept. */
      restartIncomingCalls?: () => Promise<void>;
      /** Auto-close chat (Bale message) tunnels that transfer zero bytes for this many ms. */
      zeroTransferTimeoutMs?: number;
      /** Auto-close WebRTC meet tunnels that transfer zero bytes for this many ms. Defaults
       *  to 5 minutes — longer than chat because WebRTC provides its own pong keepalive. */
      meetZeroTransferTimeoutMs?: number;
      /** Protocol version for tunnel data-path. Defaults to 1 for compatibility. */
      protocolVersion?: 1 | 2;
      /** Required when protocolVersion=2. */
      identity?: V2ServerIdentity;
      /** Optional server callback for client-uploaded logs. */
      onLogReport?: (report: V2LogReport, tunnelId: string | null) => void;
    } = {},
  ) {}

  start(): void {
    const allow = this.opts.allowChatTypes ?? (['PRIVATE'] as const);
    this.startedAtMs = Date.now();
    this.offMessage = this.sidecar.onMessage((msg) => {
      this.log(`sidecar->dispatcher: chat=${msg.chat.chatType}:${msg.chat.chatId} text_len=${msg.text?.length ?? 0}`);
      if (!allow.includes(msg.chat.chatType)) {
        this.log(`  filtered: chatType ${msg.chat.chatType} not allowed`);
        return;
      }
      if (msg.text == null) {
        this.log('  filtered: null text');
        return;
      }
      this.handle(msg).catch((e) => {
        this.log(`dispatcher handle failed: ${(e as Error).message}`);
      });
    });
    this.offIncomingCall = this.opts.incomingCallSource?.onIncomingCall((event) => {
      const offeredPeer = this.meetOfferPeers.get(this.meetKey(event.callId)) ?? null;
      this.clearPendingMeetOffer(event.callId);
      this.log(
        `incoming-call push: callId=${event.callId} room=${event.roomUuid || '-'} ` +
        `base=${event.baseUrl || '-'} date=${event.dateMs ?? 'n/a'}`,
      );
      if (this.isStaleTimestamp(event.dateMs)) {
        this.log(`ignored stale incoming-call push callId=${event.callId}`);
        return;
      }
      this.spawnMeetTunnel(offeredPeer, event.callId).catch((e) => {
        this.log(`incoming-call handling failed for ${event.callId}: ${(e as Error).message}`);
      });
    }) ?? null;
    this.log('dispatcher started');
  }

  stop(): void {
    this.offMessage?.();
    this.offMessage = null;
    this.offIncomingCall?.();
    this.offIncomingCall = null;
    this.startedAtMs = null;
    this.activeMeetCalls.clear();
    this.activeMeetTunnels.clear();
    for (const timer of this.pendingMeetOffers.values()) clearTimeout(timer);
    this.pendingMeetOffers.clear();
    this.meetOfferPeers.clear();
    for (const [key, pt] of this.tunnels) {
      if (!pt.closed) {
        pt.closed = true;
        pt.transport.fireClose('dispatcher stopped');
      }
      this.tunnels.delete(key);
    }
  }

  private log(line: string): void {
    this.opts.logger?.(line);
  }

  private protocolVersion(): 1 | 2 {
    return this.opts.protocolVersion ?? 1;
  }

  private keyFor(peer: Peer, sessionTag: string | null = null): string {
    return sessionTag
      ? `${peer.chatType}:${peer.chatId}:${sessionTag}`
      : `${peer.chatType}:${peer.chatId}`;
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    const parsed = parseMagic(msg.text!);
    const peer: Peer = { chatId: msg.chat.chatId, chatType: msg.chat.chatType };
    const key = this.keyFor(peer, parsed.kind === 'frame' ? parsed.sessionTag : null);

    this.log(`inbound from ${key}: kind=${parsed.kind}`);

    if (parsed.kind === 'chat') {
      // Plaintext chat from this peer; surface to dashboard via logger, don't
      // start a tunnel.
      this.log(`chat from ${key}: ${parsed.text.slice(0, 120)}`);
      return;
    }
    if (parsed.kind === 'meet-offer') {
      if (this.isStaleMeetOffer(msg)) {
        this.log(`ignored stale meet-offer from ${this.keyFor(peer)} callId=${parsed.callId}`);
        return;
      }
      const meetKey = this.meetKey(parsed.callId);
      // If call is already active but we hadn't resolved the peer yet, update the tunnel now.
      const activeEntry = this.activeMeetTunnels.get(meetKey);
      if (activeEntry && !activeEntry.effectivePeer) {
        this.log(`late meet-offer from ${this.keyFor(peer)} for active callId=${parsed.callId}; updating peer`);
        activeEntry.effectivePeer = peer;
        this.manager.updateTunnel(activeEntry.tunnelId, { peer: toTunnelPeer(peer) });
        return;
      }
      if (this.opts.incomingCallSource) {
        this.queueMeetOffer(peer, parsed.callId);
      } else {
        await this.spawnMeetTunnel(peer, parsed.callId);
      }
      return;
    }
    if (parsed.kind !== 'frame') {
      this.log(`ignored non-frame magic from ${key}: ${parsed.kind}`);
      return;
    }
    if (parsed.protocolVersion !== this.protocolVersion()) {
      this.log(`ignored frame with protocolVersion=${parsed.protocolVersion}; server expects v${this.protocolVersion()}`);
      return;
    }

    let pt = this.tunnels.get(key);
    const isNew = !pt;
    if (!pt) {
      pt = this.spawnTunnel(peer, parsed.sessionTag);
      this.tunnels.set(key, pt);
    }
    this.log(`deliver ${parsed.body.byteLength}B to ${key} (new=${isNew})`);
    pt.transport.deliver(parsed.body);
  }

  /**
   * Handle a Meet offer: accept the call on Bale, join the LiveKit room, and
   * run the server-side tunnel over the data channel.
   *
   * `peer` is optional because the real Bale incoming-call push does not carry
   * the caller's chat identity in the subset we currently parse. In that path
   * we derive the peer from `AcceptCall`'s echoed `StartCallResult.peer`.
   */
  private async spawnMeetTunnel(peer: Peer | null, callId: bigint): Promise<void> {
    const key = this.meetKey(callId);
    this.clearPendingMeetOffer(callId);
    if (this.activeMeetCalls.has(key)) {
      this.log(`duplicate meet-offer for callId=${callId}; ignoring`);
      return;
    }
    if (!this.opts.baleClient) {
      const from = peer ? this.keyFor(peer) : `callId=${callId}`;
      this.log(`meet-offer from ${from} but no BaleClient configured - ignoring`);
      return;
    }
    if (!this.opts.livekitFactory) {
      const from = peer ? this.keyFor(peer) : `callId=${callId}`;
      this.log(`meet-offer from ${from} but no livekitFactory configured - ignoring`);
      return;
    }
    this.activeMeetCalls.add(key);
    if (peer) this.log(`meet-offer from ${this.keyFor(peer)} callId=${callId}; accepting`);
    else this.log(`incoming-call push callId=${callId}; accepting`);

    let result: StartCallResult;
    try {
      result = await this.acceptMeetCallWithRetry(callId);
    } catch (e) {
      this.activeMeetCalls.delete(key);
      this.log(`acceptCall failed for ${callId}: ${(e as Error).message}`);
      return;
    }

    let room;
    try {
      room = await this.opts.livekitFactory({
        side: 'server',
        roomName: result.roomUuid,
        identity: 'server',
        peerIdentity: 'client',
      });
    } catch (e) {
      this.activeMeetCalls.delete(key);
      this.log(`livekit connect failed for ${callId}: ${(e as Error).message}`);
      // Best-effort: hang up the call so the caller isn't left waiting.
      try { await this.opts.baleClient.discardCall(callId); } catch { /* ignore */ }
      return;
    }

    // Use the caller peer from the meet-offer chat message when available.
    // peerFromCallResult() may return the server's own peer (callee) on some Bale versions,
    // so we prefer the peer from the __WT_MEET__ chat message which is always the sender.
    const effectivePeer = peer ?? this.peerFromCallResult(result);
    const transport = makeLivekitTransport({ room });
    const label = `webrtc:${this.keyFor(effectivePeer)}`;
    const { handle, close: closeMgr } = this.manager.openTunnel(label, {
      carrier: 'webrtc',
      peer: toTunnelPeer(effectivePeer),
      protocolVersion: this.protocolVersion(),
    });

    // Track this tunnel so a late meet-offer can update the peer identity.
    const meetEntry: MeetTunnelEntry = { tunnelId: handle.id, effectivePeer: peer };
    this.activeMeetTunnels.set(key, meetEntry);

    const client = this.opts.baleClient;
    let closed = false;
    let totalTransferred = 0;
    const meetTimeout = this.meetIdleTimeoutMs();
    let idleTimer = this.armIdleTimeout(meetTimeout, () => {
      if (closed || totalTransferred > 0) return;
      closed = true;
      const reason = this.idleCloseReason(meetTimeout);
      this.activeMeetCalls.delete(key);
      this.activeMeetTunnels.delete(key);
      closeMgr(reason);
      try { transport.close(reason); } catch { /* ignore */ }
      client.discardCall(callId).catch(() => undefined);
      this.log(`webrtc tunnel closed for callId=${callId} peer=${this.keyFor(effectivePeer)}: ${reason}`);
    });
    const trackedHandle = this.withTransferTracking(handle, (n) => {
      if (n <= 0) return;
      totalTransferred += n;
      if (totalTransferred > 0) {
        idleTimer = clearTimer(idleTimer);
      }
    });
    const runPromise = this.protocolVersion() === 2
      ? runServerTunnelV2(transport, {
          identity: requireV2Identity(this.opts.identity),
          handle: trackedHandle,
          onLogReport: this.opts.onLogReport,
        }).then((res) => res.mux)
      : runServerTunnel(transport, this.psk, { handle: trackedHandle });

    // Safety net: if the client never completes the handshake within this
    // window, drop the tunnel so it doesn't linger in the dashboard as an
    // `[unknown client]` ghost.
    const handshakeTimeoutId = setTimeout(() => {
      if (closed) return;
      closed = true;
      idleTimer = clearTimer(idleTimer);
      this.activeMeetCalls.delete(key);
      this.activeMeetTunnels.delete(key);
      const reason = `handshake hard timeout after ${BaleServerDispatcher.HANDSHAKE_HARD_TIMEOUT_MS}ms`;
      closeMgr(reason);
      try { transport.close(reason); } catch { /* ignore */ }
      client.discardCall(callId).catch(() => undefined);
      this.log(`${reason} for callId=${callId} peer=${this.keyFor(effectivePeer)}`);
    }, BaleServerDispatcher.HANDSHAKE_HARD_TIMEOUT_MS);
    if (typeof (handshakeTimeoutId as unknown as { unref?: () => void }).unref === 'function') {
      (handshakeTimeoutId as unknown as { unref: () => void }).unref();
    }

    runPromise
      .then((mux) => {
        clearTimeout(handshakeTimeoutId);
        this.log(`webrtc handshake OK for callId=${callId} peer=${this.keyFor(effectivePeer)}`);
        mux.onClose((reason) => {
          if (closed) return;
          closed = true;
          idleTimer = clearTimer(idleTimer);
          this.activeMeetCalls.delete(key);
          this.activeMeetTunnels.delete(key);
          closeMgr(reason);
          try { transport.close(reason); } catch { /* ignore */ }
          this.log(`webrtc tunnel closed for callId=${callId} peer=${this.keyFor(effectivePeer)}: ${reason}`);
          client.discardCall(callId).catch(() => undefined);
        });
      })
      .catch((e) => {
        clearTimeout(handshakeTimeoutId);
        if (closed) return;
        closed = true;
        idleTimer = clearTimer(idleTimer);
        this.activeMeetCalls.delete(key);
        this.activeMeetTunnels.delete(key);
        const reason = `webrtc handshake failed: ${(e as Error).message}`;
        closeMgr(reason);
        try { transport.close(reason); } catch { /* ignore */ }
        client.discardCall(callId).catch(() => undefined);
        this.log(`${reason} for callId=${callId} peer=${this.keyFor(effectivePeer)}`);
      });
  }

  private async acceptMeetCallWithRetry(callId: bigint): Promise<StartCallResult> {
    const client = this.opts.baleClient!;
    const maxAttempts = 80;
    // CallNotFound can appear transiently in the brief window between the
    // incoming-call WS push and Bale indexing the call record. Give it a few
    // seconds — after that the call is permanently gone (expired, cancelled, or
    // the client moved on) and retrying only hammers Bale's API for no benefit.
    const callNotFoundDeadline = Date.now() + 4_000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // Ring-acknowledge first so caller sees "ringing" state, then accept.
        try { await client.receiveCall(callId); } catch { /* non-fatal */ }
        return await client.acceptCall(callId);
      } catch (e) {
        const message = (e as Error).message;
        const isCallNotFound = message.includes('CallNotFound');
        const isTransient = message.includes('http=502') || message.includes('http=503') || message.includes('http=504');
        if (isCallNotFound && Date.now() < callNotFoundDeadline) {
          this.log(`acceptCall attempt ${attempt}/${maxAttempts} failed (not ready) for ${callId}; retrying`);
          await delay(500);
          continue;
        }
        if (isTransient && attempt < maxAttempts) {
          this.log(`acceptCall attempt ${attempt}/${maxAttempts} failed (transient) for ${callId}; retrying`);
          await delay(500);
          continue;
        }
        throw e;
      }
    }
    throw new Error(`acceptCall retry loop exhausted for ${callId}`);
  }

  private queueMeetOffer(peer: Peer, callId: bigint): void {
    const key = this.meetKey(callId);
    if (this.activeMeetCalls.has(key) || this.pendingMeetOffers.has(key)) {
      this.log(`duplicate meet-offer for callId=${callId}; ignoring`);
      return;
    }
    this.meetOfferPeers.set(key, peer);
    this.log(`meet-offer from ${this.keyFor(peer)} callId=${callId}; waiting for incoming-call push`);
    const timer = setTimeout(() => {
      this.pendingMeetOffers.delete(key);
      this.meetOfferPeers.delete(key);
      this.runMeetOfferFallback(peer, callId).catch((e) => {
        this.log(`meet-offer fallback failed for ${callId}: ${(e as Error).message}`);
      });
    }, 1_500);
    this.pendingMeetOffers.set(key, timer);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  }

  private async runMeetOfferFallback(peer: Peer, callId: bigint): Promise<void> {
    if (this.activeMeetCalls.has(this.meetKey(callId))) return;
    if (this.opts.restartIncomingCalls) {
      this.log(`meet-offer fallback for ${callId}; restarting incoming-call watcher`);
      try {
        await this.opts.restartIncomingCalls();
      } catch (e) {
        this.log(`incoming-call watcher restart failed for ${callId}: ${(e as Error).message}`);
      }
      await delay(750);
      if (this.activeMeetCalls.has(this.meetKey(callId))) return;
    }
    await this.spawnMeetTunnel(peer, callId);
  }

  private clearPendingMeetOffer(callId: bigint): void {
    const key = this.meetKey(callId);
    this.meetOfferPeers.delete(key);
    const timer = this.pendingMeetOffers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingMeetOffers.delete(key);
  }

  private isStaleMeetOffer(msg: IncomingMessage): boolean {
    return this.isStaleTimestamp(msg.date);
  }

  private isStaleTimestamp(dateMs: number | null | undefined): boolean {
    if (dateMs == null || this.startedAtMs == null) return false;
    return dateMs < this.startedAtMs - 5_000;
  }

  private meetKey(callId: bigint): string {
    return String(callId);
  }

  private peerFromCallResult(result: StartCallResult): Peer {
    return {
      chatId: Number(result.peer.id),
      chatType: result.peer.type === BalePeerType.PRIVATE ? 'PRIVATE' : 'GROUP',
    };
  }

  private spawnTunnel(peer: Peer, sessionTag: string | null): PerPeerTunnel {
    const key = this.keyFor(peer, sessionTag);
    const label = sessionTag
      ? `bale:${peer.chatType.toLowerCase()}/${peer.chatId}#${sessionTag.slice(0, 8)}`
      : `bale:${peer.chatType.toLowerCase()}/${peer.chatId}`;
    const { handle, close: closeMgr } = this.manager.openTunnel(label, {
      carrier: 'chat',
      peer: toTunnelPeer(peer),
      protocolVersion: this.protocolVersion(),
    });
    const transport = createPassiveTransport({
      send: async (bytes) => {
        const payload = this.protocolVersion() === 2
          ? buildFrameMessageV2(bytes, sessionTag)
          : buildFrameMessage(bytes, sessionTag);
        await this.sidecar.sendMessage(peer, payload);
      },
    });
    const pt: PerPeerTunnel = { transport, startedAt: Date.now(), closed: false, sessionTag };
    let totalTransferred = 0;
    const chatTimeout = this.chatIdleTimeoutMs();
    let idleTimer = this.armIdleTimeout(chatTimeout, () => {
      if (pt.closed || totalTransferred > 0) return;
      pt.closed = true;
      this.tunnels.delete(key);
      const reason = this.idleCloseReason(chatTimeout);
      transport.fireClose(reason);
      closeMgr(reason);
      this.log(`tunnel closed for ${key}: ${reason}`);
    });
    const trackedHandle = this.withTransferTracking(handle, (n) => {
      if (n <= 0) return;
      totalTransferred += n;
      if (totalTransferred > 0) {
        idleTimer = clearTimer(idleTimer);
      }
    });

    const runPromise = this.protocolVersion() === 2
      ? runServerTunnelV2(transport, {
          identity: requireV2Identity(this.opts.identity),
          handle: trackedHandle,
          onLogReport: this.opts.onLogReport,
        }).then((res) => res.mux)
      : runServerTunnel(transport, this.psk, { handle: trackedHandle });

    runPromise
      .then((mux) => {
        this.log(`handshake OK for ${key}`);
        mux.onClose((reason) => {
          if (pt.closed) return;
          pt.closed = true;
          idleTimer = clearTimer(idleTimer);
          this.tunnels.delete(key);
          closeMgr(reason);
          this.log(`tunnel closed for ${key}: ${reason}`);
        });
      })
      .catch((e) => {
        idleTimer = clearTimer(idleTimer);
        const reason = `handshake failed: ${(e as Error).message}`;
        pt.closed = true;
        this.tunnels.delete(key);
        transport.fireClose(reason);
        closeMgr(reason);
        this.log(`${reason} for ${key}`);
      });

    return pt;
  }

  private withTransferTracking(handle: TunnelHandle, onTransferBytes: (n: number) => void): TunnelHandle {
    return {
      id: handle.id,
      openStream: (streamId, addr) => handle.openStream(streamId, addr),
      addBytes: (streamId, dir, n) => {
        onTransferBytes(n);
        handle.addBytes(streamId, dir, n);
      },
      closeStream: (streamId) => handle.closeStream(streamId),
      setTerminator: (terminate) => handle.setTerminator(terminate),
      setTerminable: (terminable) => handle.setTerminable(terminable),
      setProtocolVersion: (protocolVersion) => handle.setProtocolVersion(protocolVersion),
      setTerminationState: (state) => handle.setTerminationState(state),
      setClientInfo: (clientType, clientVersion) => handle.setClientInfo(clientType, clientVersion),
    };
  }

  private armIdleTimeout(ms: number, onTimeout: () => void): ReturnType<typeof setTimeout> | null {
    if (ms <= 0) return null;
    const timer = setTimeout(onTimeout, ms);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    return timer;
  }

  private chatIdleTimeoutMs(): number {
    const raw = this.opts.zeroTransferTimeoutMs ?? BaleServerDispatcher.DEFAULT_ZERO_TRANSFER_TIMEOUT_MS;
    return Number.isFinite(raw) && raw > 0 ? raw : BaleServerDispatcher.DEFAULT_ZERO_TRANSFER_TIMEOUT_MS;
  }

  private meetIdleTimeoutMs(): number {
    const raw = this.opts.meetZeroTransferTimeoutMs ?? BaleServerDispatcher.DEFAULT_MEET_ZERO_TRANSFER_TIMEOUT_MS;
    return Number.isFinite(raw) && raw > 0 ? raw : BaleServerDispatcher.DEFAULT_MEET_ZERO_TRANSFER_TIMEOUT_MS;
  }

  private idleCloseReason(ms: number): string {
    return `idle timeout: 0 B for ${Math.round(ms / 1000)}s`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer) clearTimeout(timer);
  return null;
}

interface PassiveTransport extends Transport {
  deliver(bytes: Uint8Array): void;
  fireClose(reason: string): void;
}

function createPassiveTransport(opts: { send: (bytes: Uint8Array) => Promise<void> }): PassiveTransport {
  let onMessage: ((bytes: Uint8Array) => void) | null = null;
  let onClose: ((reason: string) => void) | null = null;
  let closed = false;
  return {
    async send(bytes) {
      if (closed) return;
      try {
        await opts.send(bytes);
      } catch (e) {
        if (closed) return;
        closed = true;
        onClose?.(`send failed: ${(e as Error).message}`);
      }
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
      if (closed) cb('already closed');
    },
    close(reason = 'passive-transport closed') {
      if (closed) return;
      closed = true;
      onClose?.(reason);
    },
    deliver(bytes) {
      if (closed) return;
      onMessage?.(bytes);
    },
    fireClose(reason) {
      if (closed) return;
      closed = true;
      onClose?.(reason);
    },
  };
}

function toTunnelPeer(peer: Peer): TunnelPeerSummary {
  return {
    chatId: peer.chatId,
    chatType: peer.chatType,
    name: null,
    username: null,
  };
}

function requireV2Identity(identity: V2ServerIdentity | undefined): V2ServerIdentity {
  if (!identity) throw new Error('v2 protocol requires a server identity');
  return identity;
}
