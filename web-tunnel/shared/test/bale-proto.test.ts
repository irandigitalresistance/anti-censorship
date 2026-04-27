import { describe, expect, it } from 'vitest';
import { Reader, Writer, toSignedInt64 } from '../src/bale/proto.js';
import {
  decodePhoneAuthResponse,
  decodeUserAuth,
  decodeValidateCodeResponse,
  encodeStartPhoneAuth,
  encodeValidateCode,
} from '../src/bale/messages.js';
import { parseGrpcWebBody } from '../src/bale/grpc-web.js';

describe('proto primitives', () => {
  it('encodes and decodes small varints', () => {
    for (const n of [0, 1, 127, 128, 255, 16383, 16384, 2 ** 31 - 1]) {
      const w = new Writer();
      w.varint(n);
      const r = new Reader(w.toBytes());
      expect(Number(r.readVarint())).toBe(n);
    }
  });

  it('encodes negative int as two-complement varint', () => {
    const w = new Writer();
    w.int(1, -1);
    const r = new Reader(w.toBytes());
    const fields = [...r.fields()];
    expect(fields).toHaveLength(1);
    expect(toSignedInt64(fields[0]!.varint!)).toBe(-1n);
  });

  it('length-delimited string round-trip', () => {
    const w = new Writer();
    w.string(3, 'web-tunnel');
    const r = new Reader(w.toBytes());
    const fields = [...r.fields()];
    expect(fields).toHaveLength(1);
    expect(fields[0]!.fieldNumber).toBe(3);
    expect(new TextDecoder().decode(fields[0]!.bytes!)).toBe('web-tunnel');
  });

  it('skips unknown wire types without crashing', () => {
    // Manually build: field 1 LEN=4 bytes "abcd", field 2 FIXED32 4 bytes
    const buf = new Uint8Array([
      (1 << 3) | 2, // tag
      4, // length
      97, 98, 99, 100, // "abcd"
      (2 << 3) | 5, // tag: fixed32
      1, 2, 3, 4,
      (3 << 3) | 0, // tag: varint
      0x05,
    ]);
    const fields = [...new Reader(buf).fields()];
    // Unknown wire types are skipped but subsequent fields still parse.
    expect(fields.map((f) => f.fieldNumber)).toEqual([1, 3]);
  });
});

describe('bale auth message round-trips', () => {
  it('encodes StartPhoneAuth with all required fields', () => {
    const bytes = encodeStartPhoneAuth({
      phoneNumber: BigInt(989123456789),
      appId: 4,
      appKey: 'TESTKEY',
      deviceHash: 'device-hash-abc',
      deviceTitle: 'TestClient 1.0',
      sendCodeType: 0,
    });
    const fields = [...new Reader(bytes).fields()];
    const byNum = new Map(fields.map((f) => [f.fieldNumber, f]));
    expect(byNum.get(1)!.varint).toBe(989123456789n);
    expect(Number(byNum.get(2)!.varint)).toBe(4);
    expect(new TextDecoder().decode(byNum.get(3)!.bytes!)).toBe('TESTKEY');
    expect(new TextDecoder().decode(byNum.get(4)!.bytes!)).toBe('device-hash-abc');
    expect(new TextDecoder().decode(byNum.get(5)!.bytes!)).toBe('TestClient 1.0');
    expect(Number(byNum.get(9)!.varint)).toBe(0);
    // field 10 is present (options default {0:1} emitted as nested message)
    const optMsg = byNum.get(10)!.bytes!;
    const innerFields = [...new Reader(optMsg).fields()];
    expect(Number(innerFields[0]!.varint)).toBe(0);
    expect(Number(innerFields[1]!.varint)).toBe(1);
  });

  it('encodes ValidateCode with known wire bytes shape', () => {
    const bytes = encodeValidateCode({ transactionHash: 'txhash', code: '12345' });
    const fields = [...new Reader(bytes).fields()];
    const byNum = new Map(fields.map((f) => [f.fieldNumber, f]));
    expect(new TextDecoder().decode(byNum.get(1)!.bytes!)).toBe('txhash');
    expect(new TextDecoder().decode(byNum.get(2)!.bytes!)).toBe('12345');
    expect(byNum.has(3)).toBe(true); // is_jwt options
  });

  it('decodes a PhoneAuthResponse with all fields', () => {
    // Build a fake response: tx=abc, is_registered=1, sent_code_type=0, code_exp=123, code_timeout=60.
    const w = new Writer();
    w.string(1, 'abc');
    w.int(2, 1);
    w.int(5, 0);
    w.message(6, (m) => m.int(1, 1700000000000));
    w.message(8, (m) => m.int(1, 60));
    const out = decodePhoneAuthResponse(w.toBytes());
    expect(out.transactionHash).toBe('abc');
    expect(out.isRegistered).toBe(true);
    expect(out.sentCodeType).toBe(0);
    expect(out.codeExpirationDateMs).toBe(1700000000000n);
    expect(out.codeTimeoutSec).toBe(60n);
  });

  it('decodes a ValidateCodeResponse with embedded UserAuth and JWT', () => {
    const w = new Writer();
    w.message(2, (m) => {
      m.int(1, 1234567890);
      m.int(2, -8123456789012345678n);
      m.string(3, 'Test User');
    });
    w.message(4, (m) => m.string(1, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz'));
    const out = decodeValidateCodeResponse(w.toBytes());
    expect(out.user!.id).toBe(1234567890n);
    expect(out.user!.accessHash).toBe(-8123456789012345678n);
    expect(out.user!.name).toBe('Test User');
    expect(out.jwt).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz');
  });

  it('decodeUserAuth tolerates missing optional fields', () => {
    const w = new Writer();
    w.int(1, 42);
    w.string(3, 'Alice');
    const u = decodeUserAuth(w.toBytes());
    expect(u.id).toBe(42n);
    expect(u.name).toBe('Alice');
    expect(u.accessHash).toBe(-1n); // default
    expect(u.username).toBeUndefined();
  });
});

describe('grpc-web framing', () => {
  it('separates payload frame from trailer frame', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const payloadFrame = new Uint8Array(5 + payload.byteLength);
    payloadFrame[0] = 0;
    new DataView(payloadFrame.buffer).setUint32(1, payload.byteLength, false);
    payloadFrame.set(payload, 5);
    const trailerText = 'grpc-status: 0\r\ngrpc-message: \r\n';
    const trailerBytes = new TextEncoder().encode(trailerText);
    const trailerFrame = new Uint8Array(5 + trailerBytes.byteLength);
    trailerFrame[0] = 0x80;
    new DataView(trailerFrame.buffer).setUint32(1, trailerBytes.byteLength, false);
    trailerFrame.set(trailerBytes, 5);
    const body = new Uint8Array(payloadFrame.byteLength + trailerFrame.byteLength);
    body.set(payloadFrame, 0);
    body.set(trailerFrame, payloadFrame.byteLength);

    const parsed = parseGrpcWebBody(body);
    expect(Array.from(parsed.payload)).toEqual([1, 2, 3]);
    expect(parsed.trailers['grpc-status']).toBe('0');
    expect(parsed.trailers['grpc-message']).toBe('');
  });
});
