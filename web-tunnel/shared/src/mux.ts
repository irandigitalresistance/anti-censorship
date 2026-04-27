import type { Transport } from './transport.js';
import { Opcode, chunkPayload, decodeFrame, encodeFrame } from './frame.js';
import { decodeOpen, encodeOpen, type OpenAddress } from './open.js';
import { SessionCipher } from './handshake.js';

export interface Stream {
  readonly id: number;
  readonly addr: OpenAddress;
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  close(): void;
  onClose(cb: () => void): void;
  readonly closed: boolean;
}

type StreamHandler = (stream: Stream) => void;

interface StreamImpl extends Stream {
  _deliverData(data: Uint8Array): void;
  _remoteClose(): void;
}

export interface TunnelMuxOptions {
  transport: Transport;
  cipher: SessionCipher;
  role: 'client' | 'server';
}

export class TunnelMux {
  private readonly transport: Transport;
  private readonly cipher: SessionCipher;
  private readonly role: 'client' | 'server';
  private readonly streams = new Map<number, StreamImpl>();
  private nextClientStreamId = 1;
  private onStreamHandler: StreamHandler | null = null;
  private onCloseHandler: ((reason: string) => void) | null = null;
  private closed = false;

  constructor(opts: TunnelMuxOptions) {
    this.transport = opts.transport;
    this.cipher = opts.cipher;
    this.role = opts.role;
    this.transport.onMessage((wire) => this.handleWire(wire));
    this.transport.onClose((reason) => this.shutdown(reason));
  }

  onStream(cb: StreamHandler): void {
    this.onStreamHandler = cb;
  }

  onClose(cb: (reason: string) => void): void {
    this.onCloseHandler = cb;
  }

  openStream(addr: OpenAddress): Stream {
    if (this.role !== 'client') throw new Error('openStream is client-only');
    if (this.closed) throw new Error('mux closed');
    const id = this.nextClientStreamId;
    this.nextClientStreamId += 2;
    const stream = this.createStream(id, addr);
    this.streams.set(id, stream);
    this.sendFrame(id, Opcode.OPEN, encodeOpen(addr));
    return stream;
  }

  close(reason = 'mux closed'): void {
    this.shutdown(reason);
    this.transport.close(reason);
  }

  private sendFrame(streamId: number, opcode: Opcode, payload: Uint8Array): void {
    if (this.closed) return;
    const plain = encodeFrame({ streamId, opcode, payload });
    const ct = this.cipher.encrypt(plain);
    void this.transport.send(ct);
  }

  private handleWire(wire: Uint8Array): void {
    if (this.closed) return;
    let plain: Uint8Array;
    try {
      plain = this.cipher.decrypt(wire);
    } catch {
      this.shutdown('decrypt failed');
      return;
    }
    let frame;
    try {
      frame = decodeFrame(plain);
    } catch {
      this.shutdown('bad frame');
      return;
    }
    switch (frame.opcode) {
      case Opcode.OPEN: {
        if (this.role !== 'server') {
          this.shutdown('OPEN from server');
          return;
        }
        if (this.streams.has(frame.streamId)) {
          this.shutdown('duplicate OPEN');
          return;
        }
        let addr: OpenAddress;
        try {
          addr = decodeOpen(frame.payload);
        } catch {
          this.shutdown('bad OPEN payload');
          return;
        }
        const stream = this.createStream(frame.streamId, addr);
        this.streams.set(frame.streamId, stream);
        this.onStreamHandler?.(stream);
        return;
      }
      case Opcode.DATA: {
        const s = this.streams.get(frame.streamId);
        if (!s) return;
        s._deliverData(frame.payload);
        return;
      }
      case Opcode.CLOSE: {
        const s = this.streams.get(frame.streamId);
        if (!s) return;
        s._remoteClose();
        return;
      }
      case Opcode.PING: {
        this.sendFrame(frame.streamId, Opcode.PONG, frame.payload);
        return;
      }
      case Opcode.PONG:
      case Opcode.ACK:
        return;
    }
  }

  private createStream(id: number, addr: OpenAddress): StreamImpl {
    const self = this;
    const dataHandlers: Array<(d: Uint8Array) => void> = [];
    const closeHandlers: Array<() => void> = [];
    let streamClosed = false;
    const stream: StreamImpl = {
      id,
      addr,
      get closed() {
        return streamClosed;
      },
      write(data) {
        if (streamClosed) return;
        for (const chunk of chunkPayload(data)) {
          self.sendFrame(id, Opcode.DATA, chunk);
        }
      },
      onData(cb) {
        dataHandlers.push(cb);
      },
      close() {
        if (streamClosed) return;
        streamClosed = true;
        self.streams.delete(id);
        self.sendFrame(id, Opcode.CLOSE, new Uint8Array());
        for (const h of closeHandlers) h();
      },
      onClose(cb) {
        closeHandlers.push(cb);
      },
      _deliverData(data) {
        for (const h of dataHandlers) h(data);
      },
      _remoteClose() {
        if (streamClosed) return;
        streamClosed = true;
        self.streams.delete(id);
        for (const h of closeHandlers) h();
      },
    };
    return stream;
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams.values()) s._remoteClose();
    this.streams.clear();
    this.onCloseHandler?.(reason);
  }
}
