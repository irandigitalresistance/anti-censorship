import { describe, expect, it } from 'vitest';
import { Opcode, chunkPayload, decodeFrame, encodeFrame, MAX_CHUNK_PAYLOAD } from '../src/frame.js';

describe('frame', () => {
  it('round-trips an empty DATA frame', () => {
    const wire = encodeFrame({ streamId: 0, opcode: Opcode.DATA, payload: new Uint8Array() });
    expect(wire.byteLength).toBe(7);
    const f = decodeFrame(wire);
    expect(f.streamId).toBe(0);
    expect(f.opcode).toBe(Opcode.DATA);
    expect(f.payload.byteLength).toBe(0);
  });

  it('round-trips a DATA frame with payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wire = encodeFrame({ streamId: 0xdeadbeef, opcode: Opcode.DATA, payload });
    const f = decodeFrame(wire);
    expect(f.streamId).toBe(0xdeadbeef);
    expect(f.opcode).toBe(Opcode.DATA);
    expect(Array.from(f.payload)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects payloads larger than u16', () => {
    const payload = new Uint8Array(0x10000);
    expect(() => encodeFrame({ streamId: 1, opcode: Opcode.DATA, payload })).toThrow(/exceeds/);
  });

  it('rejects streamId outside u32', () => {
    expect(() => encodeFrame({ streamId: -1, opcode: Opcode.DATA, payload: new Uint8Array() })).toThrow(/u32/);
    expect(() => encodeFrame({ streamId: 2 ** 32, opcode: Opcode.DATA, payload: new Uint8Array() })).toThrow(/u32/);
  });

  it('rejects truncated wire bytes on decode', () => {
    expect(() => decodeFrame(new Uint8Array(3))).toThrow(/too short/);
  });

  it('rejects length mismatch on decode', () => {
    const good = encodeFrame({ streamId: 7, opcode: Opcode.DATA, payload: new Uint8Array([9]) });
    const truncated = good.slice(0, good.byteLength - 1);
    expect(() => decodeFrame(truncated)).toThrow(/length mismatch/);
  });

  it('rejects unknown opcode on decode', () => {
    const wire = new Uint8Array(7);
    new DataView(wire.buffer).setUint8(4, 0x7f);
    expect(() => decodeFrame(wire)).toThrow(/unknown opcode/);
  });

  it('chunks payloads over the default chunk size', () => {
    const big = new Uint8Array(MAX_CHUNK_PAYLOAD * 3 + 17);
    for (let i = 0; i < big.byteLength; i++) big[i] = i & 0xff;
    const chunks = chunkPayload(big);
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.byteLength).toBe(MAX_CHUNK_PAYLOAD);
    expect(chunks.at(-1)!.byteLength).toBe(17);
    const joined = new Uint8Array(big.byteLength);
    let o = 0;
    for (const c of chunks) {
      joined.set(c, o);
      o += c.byteLength;
    }
    expect(Array.from(joined)).toEqual(Array.from(big));
  });

  it('does not chunk short payloads', () => {
    const p = new Uint8Array(100);
    expect(chunkPayload(p)).toHaveLength(1);
  });

  it('round-trips each opcode', () => {
    for (const op of [Opcode.OPEN, Opcode.DATA, Opcode.CLOSE, Opcode.ACK, Opcode.PING, Opcode.PONG]) {
      const wire = encodeFrame({ streamId: 1, opcode: op, payload: new Uint8Array([42]) });
      expect(decodeFrame(wire).opcode).toBe(op);
    }
  });
});
