import { BaleClient, ChatType } from './client.js';
import type { ISidecar, IncomingMessage, Peer as BalePeer, SidecarMessageListener } from '../sidecar.js';
import type { HistoryMessage, Peer as ProtoPeer } from './messages.js';
import { ListLoadMode, PeerType } from './messages.js';

/**
 * Implements the existing `ISidecar` surface on top of the native TS `BaleClient`.
 * Replaces `PythonSidecar`. Receive is a polling loop over `loadHistory` for each
 * peer we're actively tunneling with — a deliberate v1 simplification.
 *
 * Streaming (WebSocket-RPC) would deliver real-time updates; building it is
 * Session 2 work. For now, the polling loop is configurable so the dispatcher
 * / chat transport can trade latency for Bale rate-limit pressure.
 */
export interface NativeSidecarOptions {
  client: BaleClient;
  pollIntervalMs?: number;
}

const HISTORY_PAGE_LIMIT = 200;

export class NativeBaleSidecar implements ISidecar {
  readonly me: { id: number; name: string | null; phone: string | null };
  private readonly client: BaleClient;
  private readonly pollIntervalMs: number;
  private readonly peers = new Map<string, PeerState>();
  private readonly listeners = new Set<SidecarMessageListener>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: NativeSidecarOptions) {
    this.client = opts.client;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1200;
    const session = this.client.currentSession();
    if (!session) throw new Error('NativeBaleSidecar: client has no session');
    this.me = {
      id: Number(session.userId),
      name: session.userName,
      phone: null,
    };
    this.schedulePoll();
  }

  async sendMessage(peer: BalePeer, text: string): Promise<{ messageId: number | null; date: number | null }> {
    if (this.closed) throw new Error('sidecar closed');
    const protoPeer: ProtoPeer = { type: chatTypeToPeer(peer.chatType), id: BigInt(peer.chatId) };
    this.registerPeer(protoPeer);
    const mid = await this.client.sendTextMessage(protoPeer, chatTypeEnum(peer.chatType), text);
    return { messageId: Number(mid), date: Date.now() };
  }

  onMessage(cb: SidecarMessageListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    if (this.closed) {
      cb('already closed');
      return () => undefined;
    }
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const cb of this.closeListeners) cb('native sidecar closed');
  }

  private registerPeer(peer: ProtoPeer): void {
    const key = keyOf(peer);
    if (!this.peers.has(key)) {
      this.peers.set(key, {
        peer,
        sinceDate: BigInt(Date.now()),
        seenMessageIdsAtSinceDate: new Set(),
        initialized: false,
      });
    }
  }

  private schedulePoll(): void {
    if (this.closed) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), this.pollIntervalMs);
    if (typeof (this.pollTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.pollTimer as unknown as { unref: () => void }).unref();
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.closed) return;
    try {
      // 1. List dialogs to discover peers we haven't heard of yet AND find updates.
      const dialogs = await this.client.loadDialogs(40);
      const meId = this.me.id;
      if (process.env.WT_DEBUG_BALE) process.stderr.write(`[native-sidecar] poll: ${dialogs.length} dialogs\n`);
      for (const d of dialogs) {
        const peer = d.peer;
        this.registerPeer(peer);
        const state = this.peers.get(keyOf(peer))!;
        if (!state.initialized) {
          await this.seedPeerState(state);
          continue;
        }
        if (d.senderId === BigInt(meId)) continue; // skip self
        if (d.date < state.sinceDate) continue;
        // 2. Bale history is date-based only. Multiple messages can share the
        //    same timestamp, so we fetch from one tick before the current
        //    watermark and suppress duplicates by message id within the active
        //    timestamp bucket.
        try {
          const history = await this.client.loadHistory(
            peer,
            peerToChatType(peer),
            historyOffsetFor(state),
            HISTORY_PAGE_LIMIT,
          );
          if (process.env.WT_DEBUG_BALE) process.stderr.write(`[native-sidecar] history ${keyOf(peer)}: ${history.length} msgs\n`);
          history.sort((a, b) => compareHistory(a, b));
          for (const m of history) {
            if (m.date < state.sinceDate) continue;
            const messageId = String(m.messageId);
            if (m.date === state.sinceDate && state.seenMessageIdsAtSinceDate.has(messageId)) continue;
            if (m.date > state.sinceDate) {
              state.sinceDate = m.date;
              state.seenMessageIdsAtSinceDate.clear();
            }
            state.seenMessageIdsAtSinceDate.add(messageId);
            if (m.senderId === BigInt(meId)) continue;
            this.dispatch(m, peer);
          }
        } catch (e) {
          if (process.env.WT_DEBUG_BALE === '1') {
            process.stderr.write(`[native-sidecar] history ${keyOf(peer)}: ${(e as Error).message}\n`);
          }
        }
      }
    } catch (e) {
      if (process.env.WT_DEBUG_BALE === '1') {
        process.stderr.write(`[native-sidecar] poll: ${(e as Error).message}\n`);
      }
    } finally {
      this.schedulePoll();
    }
  }

  private async seedPeerState(state: PeerState): Promise<void> {
    const history = await this.client.loadHistory(
      state.peer,
      peerToChatType(state.peer),
      0n,
      HISTORY_PAGE_LIMIT,
      ListLoadMode.BACKWARD,
    );
    if (history.length === 0) {
      state.sinceDate = BigInt(Date.now());
      state.seenMessageIdsAtSinceDate.clear();
      state.initialized = true;
      return;
    }
    history.sort((a, b) => compareHistory(a, b));
    const latestDate = history[history.length - 1]!.date;
    state.sinceDate = latestDate;
    state.seenMessageIdsAtSinceDate.clear();
    for (const message of history) {
      if (message.date === latestDate) {
        state.seenMessageIdsAtSinceDate.add(String(message.messageId));
      }
    }
    state.initialized = true;
  }

  private dispatch(m: HistoryMessage, peer: ProtoPeer): void {
    const msg: IncomingMessage = {
      chat: { chatId: Number(peer.id), chatType: peerToChatTypeLabel(peer) },
      senderId: Number(m.senderId),
      text: m.content.text ?? null,
      messageId: Number(m.messageId),
      date: Number(m.date),
    };
    for (const cb of this.listeners) cb(msg);
  }
}

interface PeerState {
  peer: ProtoPeer;
  sinceDate: bigint;
  seenMessageIdsAtSinceDate: Set<string>;
  initialized: boolean;
}

function historyOffsetFor(state: PeerState): bigint {
  return state.sinceDate > 0n ? state.sinceDate - 1n : state.sinceDate;
}

function compareHistory(a: HistoryMessage, b: HistoryMessage): number {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  if (a.messageId < b.messageId) return -1;
  if (a.messageId > b.messageId) return 1;
  return 0;
}

function keyOf(peer: ProtoPeer): string {
  return `${peer.type}:${peer.id}`;
}

function chatTypeToPeer(t: BalePeer['chatType']): PeerType {
  return t === 'PRIVATE' || t === 'BOT' ? PeerType.PRIVATE : PeerType.GROUP;
}

function chatTypeEnum(t: BalePeer['chatType']): ChatType {
  switch (t) {
    case 'PRIVATE':
      return ChatType.PRIVATE;
    case 'GROUP':
      return ChatType.GROUP;
    case 'CHANNEL':
      return ChatType.CHANNEL;
    case 'BOT':
      return ChatType.BOT;
  }
}

function peerToChatType(peer: ProtoPeer): ChatType {
  return peer.type === PeerType.PRIVATE ? ChatType.PRIVATE : ChatType.GROUP;
}

function peerToChatTypeLabel(peer: ProtoPeer): BalePeer['chatType'] {
  return peer.type === PeerType.PRIVATE ? 'PRIVATE' : 'GROUP';
}
