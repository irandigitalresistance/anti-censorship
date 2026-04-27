import { describe, expect, it } from 'vitest';
import {
  WT2_FLAG_COMPRESSED,
  WT2_FLAG_RELIABLE,
  decodeV2Packet,
  encodeV2Packet,
} from '../src/protocol-v2.js';

describe('protocol-v2 packet codec', () => {
  it('round-trips control packet', () => {
    const payload = new TextEncoder().encode('hello');
    const wire = encodeV2Packet({ type: 'control', channelId: 7, payload, flags: WT2_FLAG_RELIABLE });
    const decoded = decodeV2Packet(wire);
    expect(decoded.type).toBe('control');
    expect(decoded.channelId).toBe(7);
    expect(decoded.flags & WT2_FLAG_RELIABLE).toBe(WT2_FLAG_RELIABLE);
    expect(new TextDecoder().decode(decoded.payload)).toBe('hello');
  });

  it('compresses large tcp payloads when beneficial', () => {
    const payload = new Uint8Array(4000);
    payload.fill(0x41);
    const wire = encodeV2Packet({ type: 'tcp', channelId: 9, payload }, { compressionThreshold: 64, minCompressionSavings: 1 });
    const decoded = decodeV2Packet(wire);
    expect(decoded.type).toBe('tcp');
    expect(decoded.channelId).toBe(9);
    expect(decoded.flags & WT2_FLAG_COMPRESSED).toBe(WT2_FLAG_COMPRESSED);
    expect(decoded.payload).toEqual(payload);
  });
});
