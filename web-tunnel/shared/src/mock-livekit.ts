import type { LivekitRoomLike } from './livekit-transport.js';

/**
 * In-memory bus that connects multiple MockLivekitRoom instances, simulating a
 * LiveKit room without any real SFU. Mirrors the LiveKit data-channel semantics:
 * per-participant identity, optional destination filtering, reliable/lossy flag
 * (we ignore the flag since it's in-memory).
 */
export class MockLivekitBus {
  private readonly rooms = new Map<string, MockLivekitRoom>();

  register(room: MockLivekitRoom): void {
    this.rooms.set(room.localIdentity, room);
  }
  unregister(identity: string): void {
    this.rooms.delete(identity);
  }

  deliver(fromIdentity: string, bytes: Uint8Array, destinationIdentities: string[] | undefined): void {
    const targets = destinationIdentities && destinationIdentities.length > 0
      ? destinationIdentities
      : Array.from(this.rooms.keys()).filter((id) => id !== fromIdentity);
    for (const id of targets) {
      const room = this.rooms.get(id);
      if (!room) continue;
      room._deliver(bytes, fromIdentity);
    }
  }

  disconnectAll(reason = 'bus shut down'): void {
    for (const room of Array.from(this.rooms.values())) room._disconnectExternal(reason);
    this.rooms.clear();
  }
}

export class MockLivekitRoom implements LivekitRoomLike {
  readonly localIdentity: string;
  private readonly bus: MockLivekitBus;
  private readonly dataHandlers = new Set<(b: Uint8Array, from: string) => void>();
  private readonly discHandlers = new Set<(reason: string) => void>();
  private closed = false;

  constructor(bus: MockLivekitBus, localIdentity: string) {
    this.bus = bus;
    this.localIdentity = localIdentity;
    bus.register(this);
  }

  async publishData(
    bytes: Uint8Array,
    opts?: { reliable?: boolean; destinationIdentities?: string[] },
  ): Promise<void> {
    if (this.closed) throw new Error('room closed');
    // Defer delivery to simulate real async network behaviour.
    queueMicrotask(() => this.bus.deliver(this.localIdentity, bytes, opts?.destinationIdentities));
  }

  onDataReceived(cb: (bytes: Uint8Array, fromIdentity: string) => void): () => void {
    this.dataHandlers.add(cb);
    return () => this.dataHandlers.delete(cb);
  }

  onDisconnect(cb: (reason: string) => void): () => void {
    if (this.closed) {
      cb('already disconnected');
      return () => undefined;
    }
    this.discHandlers.add(cb);
    return () => this.discHandlers.delete(cb);
  }

  async disconnect(reason = 'local disconnect'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.bus.unregister(this.localIdentity);
    for (const cb of this.discHandlers) cb(reason);
  }

  _deliver(bytes: Uint8Array, fromIdentity: string): void {
    if (this.closed) return;
    for (const cb of this.dataHandlers) cb(bytes, fromIdentity);
  }

  _disconnectExternal(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.discHandlers) cb(reason);
  }
}
