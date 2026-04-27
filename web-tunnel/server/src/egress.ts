import net from 'node:net';
import dgram from 'node:dgram';
import type { UdpFlow } from '@webtunnel/shared';

interface StreamLike {
  addr: { kind: string; host: string; port: number };
  write(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  close(reason?: string): void;
  onClose(cb: (...args: unknown[]) => void): void;
}

const SPEEDTEST_HOST = 'wt-speedtest';
const SENDLOG_HOST = 'wt-sendlog';
const SPEEDTEST_CHUNK = 65_536;
const SPEEDTEST_TOTAL = 2 * 1024 * 1024; // 2 MB echo

function bindSpeedtestEgress(stream: StreamLike, onBytes?: (dir: 'up' | 'down', n: number) => void): void {
  let uploadBytes = 0;
  let downloadSent = false;
  const chunk = new Uint8Array(SPEEDTEST_CHUNK);

  stream.onData((data) => {
    onBytes?.('up', data.byteLength);
    uploadBytes += data.byteLength;
    if (!downloadSent && uploadBytes >= 4) {
      downloadSent = true;
      let sent = 0;
      while (sent < SPEEDTEST_TOTAL) {
        const toSend = Math.min(SPEEDTEST_CHUNK, SPEEDTEST_TOTAL - sent);
        onBytes?.('down', toSend);
        stream.write(chunk.subarray(0, toSend));
        sent += toSend;
      }
      stream.close('speedtest done');
    }
  });
  stream.onClose(() => { /* nothing to clean up */ });
}

function bindSendlogEgress(stream: StreamLike): void {
  const chunks: Uint8Array[] = [];
  stream.onData((data) => {
    chunks.push(new Uint8Array(data));
  });
  stream.onClose(() => {
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    const text = new TextDecoder().decode(buf);
    const lines = text.split('\n').filter((l) => l.trim());
    console.log(`[sendlog] received client log dump (${lines.length} lines):`);
    for (const line of lines) {
      console.log(`[sendlog]   ${line}`);
    }
  });
}

export function bindEgress(stream: StreamLike, onBytes?: (dir: 'up' | 'down', n: number) => void): void {
  if (stream.addr.kind !== 'domain' && stream.addr.kind !== 'ipv4' && stream.addr.kind !== 'ipv6') {
    stream.close();
    return;
  }
  if (stream.addr.host === SPEEDTEST_HOST) {
    bindSpeedtestEgress(stream, onBytes);
    return;
  }
  if (stream.addr.host === SENDLOG_HOST) {
    bindSendlogEgress(stream);
    return;
  }
  const sock = net.createConnection({ host: stream.addr.host, port: stream.addr.port });
  let connected = false;
  // Buffer data that arrives before the TCP handshake completes. Using a write
  // buffer (rather than sock.once('connect', ...) per chunk) avoids accumulating
  // unbounded event listeners on the socket when many chunks arrive in a burst.
  const pendingWrites: Uint8Array[] = [];

  sock.on('connect', () => {
    connected = true;
    for (const chunk of pendingWrites) sock.write(chunk);
    pendingWrites.length = 0;
  });
  sock.on('data', (chunk) => {
    onBytes?.('down', chunk.byteLength);
    stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  sock.on('end', () => {
    stream.close();
  });
  sock.on('error', () => {
    pendingWrites.length = 0;
    stream.close();
  });
  sock.on('close', () => {
    pendingWrites.length = 0;
    stream.close();
  });

  stream.onData((data) => {
    onBytes?.('up', data.byteLength);
    if (!connected) {
      pendingWrites.push(new Uint8Array(data));
    } else {
      sock.write(data);
    }
  });
  stream.onClose(() => {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  });
}

export function bindUdpEgress(
  flow: UdpFlow,
  opts: {
    onBytes?: (dir: 'up' | 'down', n: number) => void;
    idleTimeoutMs?: number;
  } = {},
): void {
  const { onBytes, idleTimeoutMs = 30_000 } = opts;
  if (flow.addr.kind !== 'domain' && flow.addr.kind !== 'ipv4' && flow.addr.kind !== 'ipv6') {
    flow.close('unsupported udp addr kind');
    return;
  }
  const socket = dgram.createSocket(flow.addr.kind === 'ipv6' ? 'udp6' : 'udp4');
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* ignore */ }
      flow.close('udp idle timeout');
    }, idleTimeoutMs);
    if (typeof (idleTimer as { unref?: () => void }).unref === 'function') {
      (idleTimer as { unref: () => void }).unref();
    }
  };

  socket.on('message', (msg) => {
    armIdle();
    onBytes?.('down', msg.byteLength);
    flow.send(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
  });
  socket.on('error', () => {
    if (closed) return;
    closed = true;
    try { socket.close(); } catch { /* ignore */ }
    flow.close('udp socket error');
  });
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    flow.close('udp socket closed');
  });

  flow.onMessage((data) => {
    if (closed) return;
    armIdle();
    onBytes?.('up', data.byteLength);
    socket.send(data, flow.addr.port, flow.addr.host, (err) => {
      if (!err || closed) return;
      closed = true;
      try { socket.close(); } catch { /* ignore */ }
      flow.close(`udp send failed: ${err.message}`);
    });
  });
  flow.onClose(() => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (closed) return;
    closed = true;
    try { socket.close(); } catch { /* ignore */ }
  });
  armIdle();
}
