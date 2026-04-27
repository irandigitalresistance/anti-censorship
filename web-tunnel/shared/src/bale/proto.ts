// Minimal hand-rolled protobuf codec. Only the wire-format primitives we need
// for Bale's auth + messaging + meet RPCs. No external deps.
//
// Wire types we cover:
//   0  VARINT            (int32, int64, uint32, uint64, sint32, sint64, bool, enum)
//   2  LEN               (string, bytes, nested message, packed repeated)
//
// Bale's protocol uses only wire types 0 and 2 for the fields we care about.

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Writer {
  private bytes: number[] = [];

  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  /** Low-level: emit a single byte. */
  private push(b: number): void {
    this.bytes.push(b & 0xff);
  }

  /** Emit a protobuf tag: (field_number << 3) | wire_type as a varint. */
  tag(fieldNumber: number, wireType: 0 | 2): this {
    return this.varint((fieldNumber << 3) | wireType);
  }

  /** Emit a base-128 varint. Handles values up to 2^53 safely via BigInt path. */
  varint(value: number | bigint): this {
    let v = typeof value === 'bigint' ? value : BigInt(value);
    if (v < 0n) {
      // Two's-complement 64-bit encoding for negative values.
      v = v + (1n << 64n);
    }
    while (v > 0x7fn) {
      this.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    this.push(Number(v));
    return this;
  }

  /** Emit a length-delimited value: length varint + payload. */
  lenPrefixed(payload: Uint8Array): this {
    this.varint(payload.byteLength);
    for (let i = 0; i < payload.byteLength; i++) this.push(payload[i]!);
    return this;
  }

  /** field:int (VARINT). Accepts negative (two's complement) and BigInt. */
  int(fieldNumber: number, value: number | bigint): this {
    return this.tag(fieldNumber, 0).varint(value);
  }

  /** field:string (LEN). */
  string(fieldNumber: number, value: string): this {
    return this.bytes_(fieldNumber, enc.encode(value));
  }

  /** field:bytes (LEN). */
  bytes_(fieldNumber: number, value: Uint8Array): this {
    return this.tag(fieldNumber, 2).lenPrefixed(value);
  }

  /** field:message (LEN) — caller provides a nested encoder. */
  message(fieldNumber: number, write: (m: Writer) => void): this {
    const m = new Writer();
    write(m);
    return this.bytes_(fieldNumber, m.toBytes());
  }
}

export interface Field {
  fieldNumber: number;
  wireType: 0 | 2;
  /** For VARINT: the integer as BigInt (so int64 is exact). */
  varint?: bigint;
  /** For LEN: the raw bytes. */
  bytes?: Uint8Array;
}

export class Reader {
  private readonly view: DataView;
  private readonly buf: Uint8Array;
  private offset = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  eof(): boolean {
    return this.offset >= this.buf.byteLength;
  }

  private readByte(): number {
    if (this.offset >= this.buf.byteLength) throw new Error('proto: unexpected EOF');
    return this.buf[this.offset++]!;
  }

  /** Read a varint; returns BigInt so int64 is exact. */
  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.readByte();
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('proto: varint too long');
  }

  readLenPrefixed(): Uint8Array {
    const n = Number(this.readVarint());
    if (this.offset + n > this.buf.byteLength) throw new Error('proto: LEN overruns buffer');
    const out = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** Iterate all fields in this message. Skips unknown fields gracefully. */
  *fields(): Generator<Field> {
    while (!this.eof()) {
      const tag = Number(this.readVarint());
      const fieldNumber = tag >>> 3;
      const wireType = (tag & 0x7) as 0 | 1 | 2 | 5;
      if (wireType === 0) {
        const v = this.readVarint();
        yield { fieldNumber, wireType: 0, varint: v };
      } else if (wireType === 2) {
        yield { fieldNumber, wireType: 2, bytes: this.readLenPrefixed() };
      } else if (wireType === 1) {
        // fixed64 — skip 8 bytes
        this.offset += 8;
      } else if (wireType === 5) {
        // fixed32 — skip 4 bytes
        this.offset += 4;
      } else {
        throw new Error(`proto: unsupported wire type ${wireType}`);
      }
    }
  }
}

export function decodeVarint(bytes: Uint8Array): bigint {
  return new Reader(bytes).readVarint();
}

export function decodeString(bytes: Uint8Array): string {
  return dec.decode(bytes);
}

/** Two's-complement int64 → JS number (may lose precision for very large values). */
export function toSignedInt64(raw: bigint): bigint {
  if (raw >= 1n << 63n) return raw - (1n << 64n);
  return raw;
}
