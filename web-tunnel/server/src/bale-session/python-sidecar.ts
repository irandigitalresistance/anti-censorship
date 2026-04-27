import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ISidecar, IncomingMessage, Peer, SidecarMessageListener } from '@webtunnel/shared';

export interface PythonSidecarOptions {
  /** Path to the python executable (e.g. `./server/py/.venv/bin/python`). */
  python: string;
  /** Absolute path to the session file aiobale will load/save (default `./session.bale`). */
  sessionFile?: string;
  /** Optional cwd for the spawned process; defaults to `server/py/`. */
  cwd?: string;
  /** Optional extra env vars. */
  env?: NodeJS.ProcessEnv;
  /** Max ms to wait for the `ready` event before rejecting. */
  readyTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

export class PythonSidecar implements ISidecar {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<SidecarMessageListener>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private buf = '';
  private nextReqId = 1;
  private closed = false;
  private closedReason = '';
  readonly readyPromise: Promise<void>;
  me: { id: number; name: string | null; phone: string | null } | null = null;

  constructor(opts: PythonSidecarOptions) {
    const args = ['-m', 'bale_sidecar', 'run', '--session', opts.sessionFile ?? './session.bale'];
    this.child = spawn(opts.python, args, {
      cwd: opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (process.env.WT_DEBUG_SIDECAR === '1') {
      process.stderr.write(`[sidecar] spawned pid=${this.child.pid} python=${opts.python}\n`);
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      if (process.env.WT_DEBUG_SIDECAR === '1') {
        process.stderr.write(`[sidecar-stdout] ${JSON.stringify(chunk)}\n`);
      }
      this.onStdout(chunk);
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      // Python tracebacks and aiobale log lines come here; surface for debugging.
      process.stderr.write(`[bale-sidecar] ${chunk}`);
    });
    this.child.on('exit', (code, signal) => {
      this.shutdown(`sidecar exited code=${code} signal=${signal ?? 'none'}`);
    });
    this.child.on('error', (err) => this.shutdown(`spawn error: ${err.message}`));

    const readyTimeout = opts.readyTimeoutMs ?? 30_000;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sidecar did not emit 'ready' within ${readyTimeout}ms`)), readyTimeout);
      const unwatch = this.onMessage(() => undefined); // ensure listeners set is alive
      this.onClose((reason) => {
        clearTimeout(timer);
        unwatch();
        if (!this.me) reject(new Error(`sidecar closed before ready: ${reason}`));
      });
      const readyWaiter = setInterval(() => {
        if (this.me) {
          clearInterval(readyWaiter);
          clearTimeout(timer);
          resolve();
        } else if (this.closed) {
          clearInterval(readyWaiter);
        }
      }, 25);
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        process.stderr.write(`[bale-sidecar] bad line from child: ${line}\n`);
        continue;
      }
      this.handleEvent(obj);
    }
  }

  private handleEvent(obj: Record<string, unknown>): void {
    const op = obj['op'];
    if (op === 'ready') {
      const me = obj['me'] as { id: number; name: string | null; phone: string | null } | undefined;
      this.me = me ?? null;
      return;
    }
    if (op === 'response') {
      const reqId = obj['req_id'] as number | undefined;
      if (reqId == null) return;
      const pending = this.pending.get(reqId);
      if (!pending) return;
      this.pending.delete(reqId);
      if (obj['ok']) pending.resolve(obj['data']);
      else pending.reject(new Error(String(obj['error'] ?? 'sidecar error')));
      return;
    }
    if (op === 'event' && obj['kind'] === 'message') {
      const chat = (obj['chat'] ?? {}) as { id: number; type: string };
      const msg: IncomingMessage = {
        chat: { chatId: chat.id, chatType: chat.type as IncomingMessage['chat']['chatType'] },
        senderId: obj['sender_id'] as number,
        text: (obj['text'] as string | null) ?? null,
        messageId: (obj['message_id'] as number | null) ?? null,
        date: (obj['date'] as number | null) ?? null,
      };
      for (const cb of this.listeners) cb(msg);
      return;
    }
    if (op === 'error') {
      process.stderr.write(`[bale-sidecar] error event: ${JSON.stringify(obj)}\n`);
      return;
    }
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    for (const p of this.pending.values()) p.reject(new Error(`sidecar closed: ${reason}`));
    this.pending.clear();
    for (const cb of this.closeListeners) cb(reason);
  }

  private async request<T = unknown>(payload: Record<string, unknown>): Promise<T> {
    if (this.closed) throw new Error(`sidecar closed: ${this.closedReason}`);
    const reqId = this.nextReqId++;
    const envelope = { req_id: reqId, ...payload };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(reqId, { resolve: (d) => resolve(d as T), reject });
      this.child.stdin.write(JSON.stringify(envelope) + '\n', (err) => {
        if (err) {
          this.pending.delete(reqId);
          reject(err);
        }
      });
    });
  }

  async sendMessage(peer: Peer, text: string): Promise<{ messageId: number | null; date: number | null }> {
    const data = await this.request<{ message_id: number | null; date: number | null }>({
      op: 'send_message',
      chat_id: peer.chatId,
      chat_type: peer.chatType,
      text,
    });
    return { messageId: data.message_id ?? null, date: data.date ?? null };
  }

  async loadDialogs(limit = 40): Promise<unknown[]> {
    const data = await this.request<{ dialogs: unknown[] }>({ op: 'load_dialogs', limit });
    return data.dialogs;
  }

  onMessage(cb: SidecarMessageListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    if (this.closed) {
      cb(this.closedReason);
      return () => undefined;
    }
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request({ op: 'shutdown' });
    } catch {
      /* ignore */
    }
    this.child.kill('SIGTERM');
  }
}
