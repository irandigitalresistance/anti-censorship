export const Opcode = {
  OPEN: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  ACK: 0x04,
  PING: 0x05,
  PONG: 0x06,
} as const;
export type Opcode = (typeof Opcode)[keyof typeof Opcode];

export interface Frame {
  streamId: number;
  opcode: Opcode;
  payload: Uint8Array;
}

const HEADER_BYTES = 7;
const MAX_PAYLOAD = 0xffff;

/**
 * Pre-encryption payload chunk size. Each chunk becomes exactly one frame,
 * one encrypted blob, one `__WT_FRAME__<base64>` chat message.
 *
 * Bale chat messages have a ~4096-char text cap. After AEAD overhead (24 nonce
 * + 16 tag), frame header (7), and base64 inflation (4/3×), a 2000-byte plain
 * payload → ~2735 base64 chars + 12 magic = 2747 chars. Well under 4096, with
 * safety room for unicode quirks Bale's backend applies.
 *
 * For a WebRTC data-channel transport this is suboptimal (the real SCTP cap is
 * ~16 KB); when that path is wired we'll make this configurable per-transport.
 */
export const MAX_CHUNK_PAYLOAD = 2_000;

export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.payload.byteLength > MAX_PAYLOAD) {
    throw new RangeError(`payload exceeds single-frame cap (${frame.payload.byteLength} > ${MAX_PAYLOAD}); chunk first`);
  }
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > 0xffff_ffff) {
    throw new RangeError('streamId must fit in u32');
  }
  const out = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, frame.streamId, false);
  view.setUint8(4, frame.opcode);
  view.setUint16(5, frame.payload.byteLength, false);
  out.set(frame.payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new RangeError(`frame too short (${bytes.byteLength} < ${HEADER_BYTES})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(0, false);
  const opcodeByte = view.getUint8(4);
  const len = view.getUint16(5, false);
  if (bytes.byteLength !== HEADER_BYTES + len) {
    throw new RangeError(`frame length mismatch (declared ${len}, got ${bytes.byteLength - HEADER_BYTES})`);
  }
  if (!isKnownOpcode(opcodeByte)) {
    throw new RangeError(`unknown opcode 0x${opcodeByte.toString(16)}`);
  }
  const payload = bytes.slice(HEADER_BYTES, HEADER_BYTES + len);
  return { streamId, opcode: opcodeByte, payload };
}

function isKnownOpcode(n: number): n is Opcode {
  return n === Opcode.OPEN || n === Opcode.DATA || n === Opcode.CLOSE || n === Opcode.ACK || n === Opcode.PING || n === Opcode.PONG;
}

export function chunkPayload(payload: Uint8Array, max = MAX_CHUNK_PAYLOAD): Uint8Array[] {
  if (max <= 0) throw new RangeError('max must be positive');
  if (payload.byteLength <= max) return [payload];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.byteLength; i += max) {
    chunks.push(payload.slice(i, Math.min(i + max, payload.byteLength)));
  }
  return chunks;
}
