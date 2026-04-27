/// <reference path="./lz4js.d.ts" />
import lz4js from 'lz4js';
import type { OpenAddress } from './open.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const WT2_VERSION = 2 as const;
export const WT2_FLAG_COMPRESSED = 1 << 0;
export const WT2_FLAG_RELIABLE = 1 << 1;
export const WT2_HEADER_BYTES = 10;
export const WT2_MAX_PAYLOAD = 0xffff;
export const WT2_DEFAULT_COMPRESSION_THRESHOLD = 512;
export const WT2_DEFAULT_MIN_COMPRESSION_SAVINGS = 48;

const lz4 = lz4js as unknown as {
  compress(src: Uint8Array): Uint8Array;
  decompress(src: Uint8Array): Uint8Array;
};

export type V2PacketType = 'control' | 'tcp' | 'udp' | 'log';

const PACKET_TYPE_TO_CODE: Record<V2PacketType, number> = {
  control: 1,
  tcp: 2,
  udp: 3,
  log: 4,
};

const CODE_TO_PACKET_TYPE: Record<number, V2PacketType> = {
  1: 'control',
  2: 'tcp',
  3: 'udp',
  4: 'log',
};

export interface V2Packet {
  type: V2PacketType;
  channelId: number;
  payload: Uint8Array;
  flags?: number;
}

export interface EncodeV2PacketOptions {
  compressionThreshold?: number;
  minCompressionSavings?: number;
}

export interface DecodedV2Packet extends V2Packet {
  flags: number;
}

export function encodeV2Packet(packet: V2Packet, opts: EncodeV2PacketOptions = {}): Uint8Array {
  const compressionThreshold = opts.compressionThreshold ?? WT2_DEFAULT_COMPRESSION_THRESHOLD;
  const minCompressionSavings = opts.minCompressionSavings ?? WT2_DEFAULT_MIN_COMPRESSION_SAVINGS;
  let payload = packet.payload;
  let flags = packet.flags ?? 0;

  const shouldCompress = payload.byteLength >= compressionThreshold && packet.type !== 'control';
  if (shouldCompress) {
    const compressed = toUint8Array(lz4.compress(payload));
    if (payload.byteLength - compressed.byteLength >= minCompressionSavings) {
      payload = compressed;
      flags |= WT2_FLAG_COMPRESSED;
    }
  }

  if (payload.byteLength > WT2_MAX_PAYLOAD) {
    throw new RangeError(`v2 payload exceeds ${WT2_MAX_PAYLOAD} bytes`);
  }
  if (!Number.isInteger(packet.channelId) || packet.channelId < 0 || packet.channelId > 0xffff_ffff) {
    throw new RangeError('v2 channelId must fit in u32');
  }
  const typeCode = PACKET_TYPE_TO_CODE[packet.type];
  if (!typeCode) throw new RangeError(`unknown v2 packet type: ${packet.type}`);

  const out = new Uint8Array(WT2_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, WT2_VERSION);
  view.setUint8(1, typeCode);
  view.setUint8(2, flags & 0xff);
  view.setUint8(3, 0);
  view.setUint32(4, packet.channelId >>> 0, false);
  view.setUint16(8, payload.byteLength, false);
  out.set(payload, WT2_HEADER_BYTES);
  return out;
}

export function decodeV2Packet(bytes: Uint8Array): DecodedV2Packet {
  if (bytes.byteLength < WT2_HEADER_BYTES) {
    throw new RangeError(`v2 packet too short (${bytes.byteLength} < ${WT2_HEADER_BYTES})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== WT2_VERSION) throw new RangeError(`unsupported v2 packet version: ${version}`);
  const typeCode = view.getUint8(1);
  const type = CODE_TO_PACKET_TYPE[typeCode];
  if (!type) throw new RangeError(`unknown v2 packet type code: ${typeCode}`);
  const flags = view.getUint8(2);
  const channelId = view.getUint32(4, false);
  const payloadLen = view.getUint16(8, false);
  if (payloadLen !== bytes.byteLength - WT2_HEADER_BYTES) {
    throw new RangeError(`v2 packet length mismatch (${payloadLen} != ${bytes.byteLength - WT2_HEADER_BYTES})`);
  }
  let payload: Uint8Array = bytes.slice(WT2_HEADER_BYTES);
  if ((flags & WT2_FLAG_COMPRESSED) !== 0) {
    payload = toUint8Array(lz4.decompress(payload));
  }
  return { type, channelId, payload, flags };
}

export type V2ControlMessage =
  | { kind: 'tcp-open'; streamId: number; addr: OpenAddress }
  | { kind: 'tcp-close'; streamId: number; reason?: string | null }
  | { kind: 'udp-open'; flowId: number; addr: OpenAddress }
  | { kind: 'udp-close'; flowId: number; reason?: string | null }
  | { kind: 'terminate'; reason: string }
  | { kind: 'ping'; ts: number }
  | { kind: 'pong'; ts: number };

export interface V2LogReport {
  reportId: string;
  source: string;
  sentAt: number;
  fileName: string;
  contentType: string;
  body: string;
  meta?: Record<string, string | number | boolean | null>;
}

export function encodeV2ControlMessage(msg: V2ControlMessage): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

export function decodeV2ControlMessage(bytes: Uint8Array): V2ControlMessage {
  const parsed = JSON.parse(dec.decode(bytes)) as { kind?: string };
  if (!parsed || typeof parsed.kind !== 'string') throw new Error('invalid v2 control message');
  return parsed as V2ControlMessage;
}

export function encodeV2LogReport(report: V2LogReport): Uint8Array {
  return enc.encode(JSON.stringify(report));
}

export function decodeV2LogReport(bytes: Uint8Array): V2LogReport {
  const parsed = JSON.parse(dec.decode(bytes)) as Partial<V2LogReport>;
  if (
    !parsed
    || typeof parsed.reportId !== 'string'
    || typeof parsed.source !== 'string'
    || typeof parsed.fileName !== 'string'
    || typeof parsed.contentType !== 'string'
    || typeof parsed.body !== 'string'
    || typeof parsed.sentAt !== 'number'
  ) {
    throw new Error('invalid v2 log report');
  }
  return parsed as V2LogReport;
}

function toUint8Array(input: Uint8Array | number[] | Buffer): Uint8Array {
  return Uint8Array.from(input as ArrayLike<number>);
}
