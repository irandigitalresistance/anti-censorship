import type { ISidecar, IncomingMessage, Peer, SidecarMessageListener } from './sidecar.js';

interface MockUser {
  id: number;
  name: string | null;
}

/**
 * In-memory bus for wiring up multiple mock sidecars that share a fake chat room.
 * Useful for unit-testing ChatTransport end-to-end without any Python or Bale.
 */
export class MockBalBus {
  private readonly sidecars = new Map<number, MockSidecar>();

  register(sidecar: MockSidecar): void {
    this.sidecars.set(sidecar.me!.id, sidecar);
  }

  /**
   * Deliver a message from `fromUserId` in a chat of `peerChatType` identified by `peerChatId`.
   * Every registered sidecar whose id matches `peerChatId` (for PRIVATE chats) or who
   * is listed in the recipients (for GROUP/CHANNEL; here we simulate 1:1 private only)
   * receives the message.
   */
  deliver(fromUserId: number, toPeer: Peer, text: string, messageId: number): void {
    const date = Date.now();
    // For PRIVATE, the recipient's sidecar should receive the message with
    // chat.id == sender's user id (matches how Bale models private chats).
    if (toPeer.chatType === 'PRIVATE') {
      const recipient = this.sidecars.get(toPeer.chatId);
      if (!recipient) return;
      recipient._deliver({
        chat: { chatId: fromUserId, chatType: 'PRIVATE' },
        senderId: fromUserId,
        text,
        messageId,
        date,
      });
      return;
    }
    // GROUP/CHANNEL: all sidecars get it, chat.id stays the group id.
    for (const sc of this.sidecars.values()) {
      if (sc.me!.id === fromUserId) continue;
      sc._deliver({
        chat: { chatId: toPeer.chatId, chatType: toPeer.chatType },
        senderId: fromUserId,
        text,
        messageId,
        date,
      });
    }
  }
}

export class MockSidecar implements ISidecar {
  readonly me: { id: number; name: string | null; phone: string | null };
  private readonly bus: MockBalBus;
  private readonly listeners = new Set<SidecarMessageListener>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private nextMessageId = 1;
  private closed = false;

  constructor(bus: MockBalBus, user: MockUser, phone: string | null = null) {
    this.bus = bus;
    this.me = { id: user.id, name: user.name, phone };
    bus.register(this);
  }

  async sendMessage(peer: Peer, text: string): Promise<{ messageId: number; date: number }> {
    if (this.closed) throw new Error('sidecar closed');
    const messageId = this.nextMessageId++;
    const date = Date.now();
    // Asynchronously deliver, so receivers don't get the message synchronously
    // within the sender's own await point.
    queueMicrotask(() => this.bus.deliver(this.me.id, peer, text, messageId));
    return { messageId, date };
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

  _deliver(msg: IncomingMessage): void {
    if (this.closed) return;
    for (const cb of this.listeners) cb(msg);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeListeners) cb('mock closed');
  }
}
