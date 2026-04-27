export type OpenAddress =
  | { kind: 'domain'; host: string; port: number }
  | { kind: 'ipv4'; host: string; port: number }
  | { kind: 'ipv6'; host: string; port: number };

const ADDR_DOMAIN = 0x01;
const ADDR_IPV4 = 0x02;
const ADDR_IPV6 = 0x03;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeOpen(addr: OpenAddress): Uint8Array {
  if (!Number.isInteger(addr.port) || addr.port < 0 || addr.port > 0xffff) {
    throw new RangeError('port must fit in u16');
  }
  let addrType: number;
  let hostBytes: Uint8Array;
  switch (addr.kind) {
    case 'domain':
      addrType = ADDR_DOMAIN;
      hostBytes = enc.encode(addr.host);
      if (hostBytes.byteLength > 0xff) throw new RangeError('domain >255 bytes');
      break;
    case 'ipv4':
      addrType = ADDR_IPV4;
      hostBytes = parseIpv4(addr.host);
      break;
    case 'ipv6':
      addrType = ADDR_IPV6;
      hostBytes = parseIpv6(addr.host);
      break;
  }
  const out = new Uint8Array(1 + 1 + hostBytes.byteLength + 2);
  const view = new DataView(out.buffer);
  out[0] = addrType;
  out[1] = hostBytes.byteLength;
  out.set(hostBytes, 2);
  view.setUint16(2 + hostBytes.byteLength, addr.port, false);
  return out;
}

export function decodeOpen(bytes: Uint8Array): OpenAddress {
  if (bytes.byteLength < 4) throw new RangeError('OPEN payload too short');
  const addrType = bytes[0]!;
  const hostLen = bytes[1]!;
  if (bytes.byteLength !== 2 + hostLen + 2) throw new RangeError('OPEN length mismatch');
  const hostBytes = bytes.slice(2, 2 + hostLen);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const port = view.getUint16(2 + hostLen, false);
  switch (addrType) {
    case ADDR_DOMAIN:
      return { kind: 'domain', host: dec.decode(hostBytes), port };
    case ADDR_IPV4:
      if (hostLen !== 4) throw new RangeError('ipv4 addr must be 4 bytes');
      return { kind: 'ipv4', host: `${hostBytes[0]}.${hostBytes[1]}.${hostBytes[2]}.${hostBytes[3]}`, port };
    case ADDR_IPV6:
      if (hostLen !== 16) throw new RangeError('ipv6 addr must be 16 bytes');
      return { kind: 'ipv6', host: formatIpv6(hostBytes), port };
    default:
      throw new RangeError(`unknown addr type 0x${addrType.toString(16)}`);
  }
}

function parseIpv4(s: string): Uint8Array {
  const parts = s.split('.');
  if (parts.length !== 4) throw new RangeError(`invalid ipv4: ${s}`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError(`invalid ipv4 octet: ${parts[i]}`);
    out[i] = n;
  }
  return out;
}

function parseIpv6(s: string): Uint8Array {
  const expanded = expandIpv6(s);
  const groups = expanded.split(':');
  if (groups.length !== 8) throw new RangeError(`invalid ipv6: ${s}`);
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i]!, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) throw new RangeError(`invalid ipv6 group: ${groups[i]}`);
    view.setUint16(i * 2, n, false);
  }
  return out;
}

function expandIpv6(s: string): string {
  if (!s.includes('::')) return s;
  const [head, tail] = s.split('::') as [string, string];
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) throw new RangeError(`invalid ipv6: ${s}`);
  return [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups].join(':');
}

function formatIpv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 8; i++) groups.push(view.getUint16(i * 2, false).toString(16));
  return groups.join(':');
}
