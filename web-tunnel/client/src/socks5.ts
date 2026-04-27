import net from 'node:net';
import dgram from 'node:dgram';
import type { OpenAddress, TunnelMux, TunnelMuxV2, UdpFlow, V2Stream } from '@webtunnel/shared';

type TcpStreamLike = Pick<V2Stream, 'write' | 'onData' | 'close' | 'onClose'>;
type MuxLike = Pick<TunnelMux, 'openStream'> & Partial<Pick<TunnelMuxV2, 'openUdpFlow'>>;

export interface Socks5Options {
  host?: string;
  port?: number;
  mux: MuxLike;
  onConnect?: (addr: OpenAddress) => void;
  onError?: (err: Error) => void;
}

export function startSocks5Listener(opts: Socks5Options): net.Server {
  const { host = '127.0.0.1', port = 1080, mux, onConnect, onError } = opts;
  const server = net.createServer((sock) => handleClient(sock, mux, onConnect, onError));
  server.on('error', (err) => {
    onError?.(err as Error);
  });
  server.listen(port, host);
  return server;
}

class BufferedReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private error: Error | null = null;
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.pump();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.pump();
  };
  private readonly onError = (err: Error): void => {
    this.error = err;
    this.pump();
  };

  constructor(private readonly sock: net.Socket) {
    sock.on('data', this.onData);
    sock.once('end', this.onEnd);
    sock.once('error', this.onError);
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.pump();
    });
  }

  private pump(): void {
    const w = this.waiter;
    if (!w) return;
    if (this.error) {
      this.waiter = null;
      w.reject(this.error);
      return;
    }
    if (this.buffer.byteLength >= w.n) {
      const out = this.buffer.subarray(0, w.n);
      this.buffer = this.buffer.subarray(w.n);
      this.waiter = null;
      w.resolve(Buffer.from(out));
      return;
    }
    if (this.ended) {
      this.waiter = null;
      w.reject(new Error('socket ended before expected bytes'));
    }
  }

  detach(): Buffer {
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('error', this.onError);
    return this.buffer;
  }
}

async function handleClient(
  sock: net.Socket,
  mux: MuxLike,
  onConnect?: (addr: OpenAddress) => void,
  onError?: (err: Error) => void,
): Promise<void> {
  sock.on('error', () => {
    sock.destroy();
  });

  const reader = new BufferedReader(sock);
  try {
    const greet = await reader.read(2);
    const ver = greet[0]!;
    const nMethods = greet[1]!;
    if (ver !== 5) throw new Error(`socks5 only (got ${ver})`);
    await reader.read(nMethods);
    sock.write(Uint8Array.of(0x05, 0x00));

    const header = await reader.read(4);
    if (header[0] !== 5) throw new Error(`bad socks version ${header[0]}`);
    const cmd = header[1]!;
    const atyp = header[3]!;
    if (cmd === 0x01) {
      await handleConnect(sock, reader, mux, atyp, onConnect, onError);
      return;
    }
    if (cmd === 0x03) {
      await handleUdpAssociate(sock, reader, mux, atyp);
      return;
    }
    sock.write(replyFailure(0x07));
    sock.end();
  } catch (e) {
    onError?.(e instanceof Error ? e : new Error(String(e)));
    sock.destroy();
  }
}

async function handleConnect(
  sock: net.Socket,
  reader: BufferedReader,
  mux: MuxLike,
  atyp: number,
  onConnect?: (addr: OpenAddress) => void,
  onError?: (err: Error) => void,
): Promise<void> {
  const addr = await parseAddr(reader, atyp);
  onConnect?.(addr);

  let stream: TcpStreamLike;
  try {
    stream = mux.openStream(addr) as unknown as TcpStreamLike;
  } catch (e) {
    sock.write(replyFailure(0x01));
    sock.end();
    throw e;
  }

  sock.write(replySuccess());

  const leftover = reader.detach();
  if (leftover.byteLength > 0) {
    stream.write(new Uint8Array(leftover.buffer, leftover.byteOffset, leftover.byteLength));
  }

  stream.onData((data) => {
    sock.write(data);
  });
  stream.onClose(() => {
    sock.end();
  });
  sock.on('data', (chunk) => {
    stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  });
  sock.on('end', () => {
    stream.close();
  });
  sock.on('close', () => {
    stream.close();
  });
  sock.on('error', (e) => {
    onError?.(e);
  });
}

async function handleUdpAssociate(
  sock: net.Socket,
  reader: BufferedReader,
  mux: MuxLike,
  atyp: number,
): Promise<void> {
  if (!mux.openUdpFlow) {
    sock.write(replyFailure(0x07));
    sock.end();
    return;
  }
  // Consume and ignore requested endpoint from client.
  await parseAddr(reader, atyp);

  const udp = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, '127.0.0.1', () => resolve());
  });
  const addr = udp.address();
  if (typeof addr === 'string') throw new Error('unexpected udp socket address');
  sock.write(replySuccessBound('127.0.0.1', addr.port));

  const flowsByKey = new Map<string, UdpFlow>();
  let clientEndpoint: { address: string; port: number } | null = null;

  const closeAll = (): void => {
    for (const flow of flowsByKey.values()) flow.close('udp associate closed');
    flowsByKey.clear();
    try { udp.close(); } catch { /* ignore */ }
  };

  udp.on('message', (msg, rinfo) => {
    const parsed = parseSocksUdpDatagram(msg);
    if (!parsed) return;
    clientEndpoint = { address: rinfo.address, port: rinfo.port };
    const key = flowKey(parsed.addr);
    let flow = flowsByKey.get(key);
    if (!flow) {
      flow = mux.openUdpFlow!(parsed.addr);
      flowsByKey.set(key, flow);
      flow.onMessage((payload) => {
        const endpoint = clientEndpoint;
        if (!endpoint) return;
        const wire = encodeSocksUdpDatagram(parsed.addr, payload);
        udp.send(wire, endpoint.port, endpoint.address);
      });
      flow.onClose(() => {
        flowsByKey.delete(key);
      });
    }
    flow.send(parsed.payload);
  });

  const shutdown = (): void => {
    closeAll();
    sock.end();
  };
  sock.on('close', shutdown);
  sock.on('end', shutdown);
  sock.on('error', shutdown);
}

async function parseAddr(reader: BufferedReader, atyp: number): Promise<OpenAddress> {
  switch (atyp) {
    case 0x01: {
      const bytes = await reader.read(4 + 2);
      const port = (bytes[4]! << 8) | bytes[5]!;
      return { kind: 'ipv4', host: `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`, port };
    }
    case 0x03: {
      const lenBuf = await reader.read(1);
      const len = lenBuf[0]!;
      const rest = await reader.read(len + 2);
      const host = rest.subarray(0, len).toString('utf8');
      const port = (rest[len]! << 8) | rest[len + 1]!;
      return { kind: 'domain', host, port };
    }
    case 0x04: {
      const bytes = await reader.read(16 + 2);
      const groups: string[] = [];
      for (let i = 0; i < 8; i++) groups.push(bytes.readUInt16BE(i * 2).toString(16));
      const port = (bytes[16]! << 8) | bytes[17]!;
      return { kind: 'ipv6', host: groups.join(':'), port };
    }
    default:
      throw new Error(`unsupported SOCKS5 atyp ${atyp}`);
  }
}

function replySuccess(): Uint8Array {
  return Uint8Array.of(0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function replyFailure(code: number): Uint8Array {
  return Uint8Array.of(0x05, code, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

function replySuccessBound(host: string, port: number): Uint8Array {
  const hostParts = host.split('.').map((p) => Number(p));
  if (hostParts.length !== 4 || hostParts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`invalid reply host ${host}`);
  }
  return Uint8Array.of(
    0x05, 0x00, 0x00, 0x01,
    hostParts[0]!, hostParts[1]!, hostParts[2]!, hostParts[3]!,
    (port >> 8) & 0xff, port & 0xff,
  );
}

function parseSocksUdpDatagram(msg: Buffer): { addr: OpenAddress; payload: Uint8Array } | null {
  if (msg.byteLength < 4) return null;
  // RSV(2) FRAG(1) ATYP(1)
  const frag = msg[2]!;
  if (frag !== 0) return null;
  const atyp = msg[3]!;
  let offset = 4;
  let addr: OpenAddress;
  if (atyp === 0x01) {
    if (msg.byteLength < offset + 4 + 2) return null;
    const host = `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
    offset += 4;
    const port = (msg[offset]! << 8) | msg[offset + 1]!;
    offset += 2;
    addr = { kind: 'ipv4', host, port };
  } else if (atyp === 0x03) {
    if (msg.byteLength < offset + 1) return null;
    const len = msg[offset]!;
    offset += 1;
    if (msg.byteLength < offset + len + 2) return null;
    const host = msg.subarray(offset, offset + len).toString('utf8');
    offset += len;
    const port = (msg[offset]! << 8) | msg[offset + 1]!;
    offset += 2;
    addr = { kind: 'domain', host, port };
  } else if (atyp === 0x04) {
    if (msg.byteLength < offset + 16 + 2) return null;
    const ipv6 = msg.subarray(offset, offset + 16);
    const groups: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      groups.push(ipv6.readUInt16BE(i * 2).toString(16));
    }
    offset += 16;
    const port = (msg[offset]! << 8) | msg[offset + 1]!;
    offset += 2;
    addr = { kind: 'ipv6', host: groups.join(':'), port };
  } else {
    return null;
  }
  return {
    addr,
    payload: new Uint8Array(msg.buffer, msg.byteOffset + offset, msg.byteLength - offset),
  };
}

function encodeSocksUdpDatagram(addr: OpenAddress, payload: Uint8Array): Buffer {
  if (addr.kind === 'ipv4') {
    const parts = addr.host.split('.').map((p) => Number(p));
    if (parts.length !== 4) throw new Error(`invalid ipv4 ${addr.host}`);
    return Buffer.concat([
      Buffer.from([0, 0, 0, 0x01, parts[0]!, parts[1]!, parts[2]!, parts[3]!, (addr.port >> 8) & 0xff, addr.port & 0xff]),
      Buffer.from(payload),
    ]);
  }
  if (addr.kind === 'domain') {
    const hostBytes = Buffer.from(addr.host, 'utf8');
    if (hostBytes.byteLength > 255) throw new Error('domain too long for socks udp datagram');
    return Buffer.concat([
      Buffer.from([0, 0, 0, 0x03, hostBytes.byteLength]),
      hostBytes,
      Buffer.from([(addr.port >> 8) & 0xff, addr.port & 0xff]),
      Buffer.from(payload),
    ]);
  }
  const groups = expandIpv6(addr.host);
  const ipv6 = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    ipv6.writeUInt16BE(parseInt(groups[i]!, 16), i * 2);
  }
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x04]),
    ipv6,
    Buffer.from([(addr.port >> 8) & 0xff, addr.port & 0xff]),
    Buffer.from(payload),
  ]);
}

function expandIpv6(input: string): string[] {
  if (!input.includes('::')) return input.split(':');
  const [head, tail] = input.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array<string>(Math.max(0, missing)).fill('0'), ...tailParts];
}

function flowKey(addr: OpenAddress): string {
  return `${addr.kind}:${addr.host}:${addr.port}`;
}
