import WebSocket, { type RawData } from 'ws';
import type { BaleSession } from './client.js';
import { Reader, Writer, decodeString, toSignedInt64 } from './proto.js';

const BALE_WS_URL = 'wss://next-ws.bale.ai/ws/';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const DEFAULT_KEEPALIVE_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const INCOMING_CALL_PUSH_TAG = 52807;

export interface IncomingCallEvent {
  callId: bigint;
  roomUuid: string;
  baseUrl: string;
  dateMs: number | null;
}

export interface IncomingCallSource {
  onIncomingCall(cb: (event: IncomingCallEvent) => void): () => void;
}

export interface BaleIncomingCallWatcherOptions {
  session: BaleSession;
  wsUrl?: string;
  userAgent?: string;
  keepaliveMs?: number;
  reconnectDelayMs?: number;
  includeUidQuery?: boolean;
  logger?: (line: string) => void;
}

/**
 * Minimal Bale WS listener that keeps a logged-in session attached to Bale's
 * update stream and extracts just the incoming-call push we need for real
 * Meet/WebRTC accept flow.
 */
export class BaleIncomingCallWatcher implements IncomingCallSource {
  private readonly listeners = new Set<(event: IncomingCallEvent) => void>();
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restartRequested = false;
  private started = false;
  private closed = false;
  private pingId = 0;
  private frameCount = 0;
  private initialReady: Promise<void> | null = null;
  private settleInitialReady:
    | { resolve: () => void; reject: (error: Error) => void; settled: boolean }
    | null = null;

  constructor(private readonly opts: BaleIncomingCallWatcherOptions) {}

  async start(): Promise<void> {
    if (this.closed) throw new Error('incoming-call watcher is closed');
    if (this.started) return this.initialReady ?? Promise.resolve();
    this.started = true;
    this.initialReady = new Promise<void>((resolve, reject) => {
      this.settleInitialReady = { resolve, reject, settled: false };
    });
    this.connect();
    return this.initialReady;
  }

  onIncomingCall(cb: (event: IncomingCallEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.started = false;
    this.restartRequested = false;
    this.clearPingTimer();
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      ws.once('close', finish);
      try {
        ws.close();
      } catch {
        finish();
      }
      setTimeout(finish, 2_000);
    });
  }

  private connect(): void {
    if (this.closed || this.ws) return;
    const url = new URL(this.opts.wsUrl ?? BALE_WS_URL);
    if (this.opts.includeUidQuery ?? true) {
      url.searchParams.set('uid', String(this.opts.session.userId));
    }
    const ws = new WebSocket(url, {
      headers: {
        Cookie: `access_token=${this.opts.session.jwt}`,
        Origin: 'https://web.bale.ai',
        'User-Agent': this.opts.userAgent ?? DEFAULT_USER_AGENT,
      },
    });
    this.ws = ws;

    ws.once('open', () => {
      this.log('incoming-call watcher connected');
      try {
        ws.send(encodeHandshakeRequest());
      } catch (e) {
        this.rejectInitialReady(e);
        return;
      }
      this.startPingLoop();
      this.resolveInitialReady();
    });

    ws.on('message', (data: RawData) => {
      const bytes = normalizeRawData(data);
      if (!bytes) return;
      this.frameCount += 1;
      if (process.env.WT_DEBUG_BALE_WS === '1') {
        this.log(`ws frame #${this.frameCount}: ${describeFrame(bytes)}`);
      }
      const incoming = decodeIncomingCallEvent(bytes);
      if (!incoming) return;
      for (const cb of this.listeners) cb(incoming);
    });

    ws.once('error', (error: Error) => {
      this.log(`incoming-call watcher error: ${error.message}`);
      this.rejectInitialReady(error);
    });

    ws.once('close', (code: number, reason: Buffer) => {
      if (this.ws === ws) this.ws = null;
      this.clearPingTimer();
      const detail = reason.toString('utf8');
      this.log(`incoming-call watcher closed code=${code} reason=${detail || 'none'}`);
      if (this.closed) return;
      if (this.restartRequested) {
        this.restartRequested = false;
        this.connect();
        return;
      }
      this.scheduleReconnect();
    });
  }

  async restart(): Promise<void> {
    if (this.closed) throw new Error('incoming-call watcher is closed');
    this.started = true;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.initialReady = new Promise<void>((resolve, reject) => {
      this.settleInitialReady = { resolve, reject, settled: false };
    });

    const ws = this.ws;
    if (!ws) {
      this.restartRequested = false;
      this.connect();
      return this.initialReady;
    }

    this.restartRequested = true;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      ws.once('close', finish);
      try {
        ws.close();
      } catch {
        finish();
      }
      setTimeout(finish, 2_000);
    });
    if (!this.ws && this.restartRequested) {
      this.restartRequested = false;
      this.connect();
    }
    return this.initialReady;
  }

  private startPingLoop(): void {
    this.clearPingTimer();
    const intervalMs = this.opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    const tick = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        this.pingId += 1;
        ws.send(encodePingRequest(this.pingId));
      } catch (e) {
        this.log(`incoming-call watcher ping failed: ${(e as Error).message}`);
      }
    }, intervalMs);
    this.pingTimer = tick;
    if (typeof (tick as unknown as { unref?: () => void }).unref === 'function') {
      (tick as unknown as { unref: () => void }).unref();
    }
  }

  private clearPingTimer(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delayMs = this.opts.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.log(`scheduling reconnect in ${delayMs}ms`);
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      this.log('attempting reconnect');
      this.connect();
    }, delayMs);
    this.reconnectTimer = timer;
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resolveInitialReady(): void {
    if (!this.settleInitialReady || this.settleInitialReady.settled) return;
    this.settleInitialReady.settled = true;
    this.settleInitialReady.resolve();
  }

  private rejectInitialReady(error: unknown): void {
    if (!this.settleInitialReady || this.settleInitialReady.settled) return;
    this.settleInitialReady.settled = true;
    this.settleInitialReady.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private log(line: string): void {
    this.opts.logger?.(line);
  }
}

export function decodeIncomingCallEvent(frame: Uint8Array): IncomingCallEvent | null {
  let updateBodyBytes: Uint8Array | null = null;
  for (const field of new Reader(frame).fields()) {
    if (field.fieldNumber !== 2 || field.wireType !== 2) continue;
    for (const inner of new Reader(field.bytes!).fields()) {
      if (inner.fieldNumber === 1 && inner.wireType === 2) {
        updateBodyBytes = inner.bytes!;
        break;
      }
    }
    if (updateBodyBytes) break;
  }
  if (!updateBodyBytes) return null;

  let updateBytes: Uint8Array | null = null;
  let dateMs: number | null = null;
  for (const field of new Reader(updateBodyBytes).fields()) {
    if (field.fieldNumber === 1 && field.wireType === 2) updateBytes = field.bytes!;
    if (field.fieldNumber === 4 && field.wireType === 0) dateMs = Number(toSignedInt64(field.varint!));
  }
  if (!updateBytes) return null;

  for (const field of new Reader(updateBytes).fields()) {
    if (field.fieldNumber !== INCOMING_CALL_PUSH_TAG || field.wireType !== 2) continue;
    return decodeIncomingCallPayload(field.bytes!, dateMs);
  }
  return null;
}

function decodeIncomingCallPayload(bytes: Uint8Array, dateMs: number | null): IncomingCallEvent | null {
  let callId: bigint | null = null;
  let roomUuid = '';
  let baseUrl = '';
  let nestedPayload: Uint8Array | null = null;
  for (const field of new Reader(bytes).fields()) {
    switch (field.fieldNumber) {
      case 1:
        if (field.wireType === 0) callId = toSignedInt64(field.varint!);
        else if (field.wireType === 2 && nestedPayload == null) nestedPayload = field.bytes!;
        break;
      case 3:
        if (field.wireType === 2) roomUuid = decodeString(field.bytes!);
        break;
      case 4:
        if (field.wireType === 2) {
          for (const inner of new Reader(field.bytes!).fields()) {
            if (inner.fieldNumber === 1 && inner.wireType === 2) {
              baseUrl = decodeString(inner.bytes!);
            }
          }
        }
        break;
    }
  }
  if (callId == null && nestedPayload) {
    return decodeIncomingCallPayload(nestedPayload, dateMs);
  }
  if (callId == null) return null;
  return { callId, roomUuid, baseUrl, dateMs };
}

function encodeHandshakeRequest(): Uint8Array {
  const w = new Writer();
  w.message(3, (m) => {
    m.int(1, 1);
    m.int(2, 1);
  });
  return w.toBytes();
}

function encodePingRequest(id: number): Uint8Array {
  const w = new Writer();
  w.message(2, (m) => {
    m.int(1, id);
  });
  return w.toBytes();
}

function normalizeRawData(data: RawData): Uint8Array | null {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    return new Uint8Array(merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
}

function describeFrame(frame: Uint8Array): string {
  const topFields = [...new Reader(frame).fields()].map((field) => `${field.fieldNumber}/${field.wireType}`);
  let updateFields = '';
  let incomingCallFields = '';
  for (const field of new Reader(frame).fields()) {
    if (field.fieldNumber !== 2 || field.wireType !== 2) continue;
    let updateBodyBytes: Uint8Array | null = null;
    for (const inner of new Reader(field.bytes!).fields()) {
      if (inner.fieldNumber === 1 && inner.wireType === 2) {
        updateBodyBytes = inner.bytes!;
        break;
      }
    }
    if (!updateBodyBytes) break;
    for (const inner of new Reader(updateBodyBytes).fields()) {
      if (inner.fieldNumber !== 1 || inner.wireType !== 2) continue;
      const updateKinds = [...new Reader(inner.bytes!).fields()].map((f) => String(f.fieldNumber));
      updateFields = ` updateKinds=[${updateKinds.join(',')}]`;
      for (const updateField of new Reader(inner.bytes!).fields()) {
        if (updateField.fieldNumber !== INCOMING_CALL_PUSH_TAG || updateField.wireType !== 2) continue;
        const payloadFields = [...new Reader(updateField.bytes!).fields()].map((f) => `${f.fieldNumber}/${f.wireType}`);
        incomingCallFields = ` incomingCall=[${payloadFields.join(',')}]`;
        for (const payloadField of new Reader(updateField.bytes!).fields()) {
          if (payloadField.wireType !== 2) continue;
          const nestedFields = [...new Reader(payloadField.bytes!).fields()].map((f) => `${f.fieldNumber}/${f.wireType}`);
          if (nestedFields.length > 0) {
            incomingCallFields += ` nested${payloadField.fieldNumber}=[${nestedFields.join(',')}]`;
          }
        }
        break;
      }
      break;
    }
    break;
  }
  return `len=${frame.byteLength} top=[${topFields.join(',')}]${updateFields}${incomingCallFields}`;
}
