export const MEDIA_VIDEO_FRAME_WIDTH = 640;
export const MEDIA_VIDEO_FRAME_HEIGHT = 360;
export const MEDIA_VIDEO_GRID_COLS = 160;
export const MEDIA_VIDEO_GRID_ROWS = 90;
export const MEDIA_VIDEO_SYMBOL_BITS = 2;
export const MEDIA_VIDEO_PACKET_BYTES = (MEDIA_VIDEO_GRID_COLS * MEDIA_VIDEO_GRID_ROWS * MEDIA_VIDEO_SYMBOL_BITS) / 8;
export const MEDIA_VIDEO_PAYLOAD_BYTES = MEDIA_VIDEO_PACKET_BYTES - 17;

const MAGIC0 = 0x57; // W
const MAGIC1 = 0x54; // T
const MAGIC2 = 0x4d; // M
const VERSION = 2;
const HEADER_BYTES = 15;
const CRC_OFFSET = MEDIA_VIDEO_PACKET_BYTES - 2;
const NO_ACK = 0xffff;
const SYMBOL_VALUES = [24, 96, 160, 232] as const;

export const MediaVideoPacketKind = {
  Ack: 0,
  Data: 1,
} as const;
export type MediaVideoPacketKind = (typeof MediaVideoPacketKind)[keyof typeof MediaVideoPacketKind];

export interface MediaVideoPacket {
  kind: MediaVideoPacketKind;
  seq: number;
  ackSeq: number | null;
  msgId: number;
  fragIndex: number;
  fragCount: number;
  payload: Uint8Array;
}

export function encodeMediaVideoPacket(packet: MediaVideoPacket): Uint8Array {
  if (packet.payload.byteLength > MEDIA_VIDEO_PAYLOAD_BYTES) {
    throw new RangeError(`media-video payload too large (${packet.payload.byteLength} > ${MEDIA_VIDEO_PAYLOAD_BYTES})`);
  }
  if (!isU16(packet.seq) || !isU16(packet.msgId)) throw new RangeError('seq/msgId must fit in uint16');
  if (!isU8(packet.fragIndex) || !isU8(packet.fragCount)) throw new RangeError('fragment index/count must fit in uint8');
  const out = new Uint8Array(MEDIA_VIDEO_PACKET_BYTES);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = MAGIC2;
  out[3] = VERSION;
  out[4] = packet.kind;
  writeU16(out, 5, packet.seq);
  writeU16(out, 7, packet.ackSeq == null ? NO_ACK : packet.ackSeq);
  writeU16(out, 9, packet.msgId);
  out[11] = packet.fragIndex;
  out[12] = packet.fragCount;
  writeU16(out, 13, packet.payload.byteLength);
  out.set(packet.payload, HEADER_BYTES);
  writeU16(out, CRC_OFFSET, crc16(out.subarray(0, CRC_OFFSET)));
  return out;
}

export function decodeMediaVideoPacket(bytes: Uint8Array): MediaVideoPacket | null {
  if (bytes.byteLength < MEDIA_VIDEO_PACKET_BYTES) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1 || bytes[2] !== MAGIC2 || bytes[3] !== VERSION) return null;
  const expectedCrc = readU16(bytes, CRC_OFFSET);
  const actualCrc = crc16(bytes.subarray(0, CRC_OFFSET));
  if (expectedCrc !== actualCrc) return null;
  const payloadLen = readU16(bytes, 13);
  if (payloadLen > MEDIA_VIDEO_PAYLOAD_BYTES) return null;
  const kind = bytes[4]!;
  if (kind !== MediaVideoPacketKind.Ack && kind !== MediaVideoPacketKind.Data) return null;
  const ack = readU16(bytes, 7);
  return {
    kind,
    seq: readU16(bytes, 5),
    ackSeq: ack === NO_ACK ? null : ack,
    msgId: readU16(bytes, 9),
    fragIndex: bytes[11]!,
    fragCount: bytes[12]!,
    payload: bytes.slice(HEADER_BYTES, HEADER_BYTES + payloadLen),
  };
}

export function encodeMediaVideoPacketToI420(packetBytes: Uint8Array, width = MEDIA_VIDEO_FRAME_WIDTH, height = MEDIA_VIDEO_FRAME_HEIGHT): Uint8Array {
  if (packetBytes.byteLength !== MEDIA_VIDEO_PACKET_BYTES) {
    throw new RangeError(`media-video packet must be ${MEDIA_VIDEO_PACKET_BYTES} bytes`);
  }
  const chromaWidth = Math.trunc((width + 1) / 2);
  const chromaHeight = Math.trunc((height + 1) / 2);
  const yBytes = width * height;
  const out = new Uint8Array(yBytes + chromaWidth * chromaHeight * 2);
  fillGrid(out, width, height, packetBytes);
  out.fill(128, yBytes);
  return out;
}

export function decodeMediaVideoPacketFromI420(frameBytes: Uint8Array, width: number, height: number): Uint8Array {
  if (frameBytes.byteLength < width * height) {
    throw new RangeError('I420 frame is missing the luma plane');
  }
  const out = new Uint8Array(MEDIA_VIDEO_PACKET_BYTES);
  const symbols = MEDIA_VIDEO_PACKET_BYTES * (8 / MEDIA_VIDEO_SYMBOL_BITS);
  for (let symbolIndex = 0; symbolIndex < symbols; symbolIndex += 1) {
    const col = symbolIndex % MEDIA_VIDEO_GRID_COLS;
    const row = Math.floor(symbolIndex / MEDIA_VIDEO_GRID_COLS);
    const symbol = readCellSymbol(frameBytes, width, height, col, row);
    writeSymbol(out, symbolIndex, symbol);
  }
  return out;
}

export function encodeMediaVideoAckPayload(seqs: readonly number[]): Uint8Array {
  const maxSeqs = Math.floor(MEDIA_VIDEO_PAYLOAD_BYTES / 2);
  const count = Math.min(seqs.length, maxSeqs);
  const out = new Uint8Array(count * 2);
  for (let i = 0; i < count; i += 1) writeU16(out, i * 2, seqs[i]!);
  return out;
}

export function decodeMediaVideoAckPayload(payload: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < payload.byteLength; i += 2) out.push(readU16(payload, i));
  return out;
}

function fillGrid(yPlane: Uint8Array, width: number, height: number, packetBytes: Uint8Array): void {
  for (let row = 0; row < MEDIA_VIDEO_GRID_ROWS; row += 1) {
    const y0 = Math.floor((row * height) / MEDIA_VIDEO_GRID_ROWS);
    const y1 = Math.floor(((row + 1) * height) / MEDIA_VIDEO_GRID_ROWS);
    for (let col = 0; col < MEDIA_VIDEO_GRID_COLS; col += 1) {
      const symbolIndex = row * MEDIA_VIDEO_GRID_COLS + col;
      const value = SYMBOL_VALUES[readSymbol(packetBytes, symbolIndex)]!;
      const x0 = Math.floor((col * width) / MEDIA_VIDEO_GRID_COLS);
      const x1 = Math.floor(((col + 1) * width) / MEDIA_VIDEO_GRID_COLS);
      for (let y = y0; y < y1; y += 1) {
        yPlane.fill(value, y * width + x0, y * width + x1);
      }
    }
  }
}

function readCellSymbol(yPlane: Uint8Array, width: number, height: number, col: number, row: number): number {
  const x0 = Math.floor(((col + 0.25) * width) / MEDIA_VIDEO_GRID_COLS);
  const x1 = Math.max(x0 + 1, Math.floor(((col + 0.75) * width) / MEDIA_VIDEO_GRID_COLS));
  const y0 = Math.floor(((row + 0.25) * height) / MEDIA_VIDEO_GRID_ROWS);
  const y1 = Math.max(y0 + 1, Math.floor(((row + 0.75) * height) / MEDIA_VIDEO_GRID_ROWS));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      sum += yPlane[y * width + x]!;
      n += 1;
    }
  }
  const avg = sum / Math.max(1, n);
  if (avg < 60) return 0;
  if (avg < 128) return 1;
  if (avg < 196) return 2;
  return 3;
}

function readSymbol(bytes: Uint8Array, symbolIndex: number): number {
  const byteIndex = Math.floor(symbolIndex / 4);
  const shift = 6 - (symbolIndex % 4) * 2;
  return (bytes[byteIndex]! >> shift) & 0x03;
}

function writeSymbol(bytes: Uint8Array, symbolIndex: number, symbol: number): void {
  const byteIndex = Math.floor(symbolIndex / 4);
  const shift = 6 - (symbolIndex % 4) * 2;
  bytes[byteIndex] = (bytes[byteIndex]! & ~(0x03 << shift)) | ((symbol & 0x03) << shift);
}

function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function isU16(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function isU8(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

function writeU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 8) & 0xff;
  out[offset + 1] = value & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}
