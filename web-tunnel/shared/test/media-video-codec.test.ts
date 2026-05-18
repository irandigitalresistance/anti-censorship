import { describe, expect, it } from 'vitest';
import {
  MEDIA_VIDEO_FRAME_HEIGHT,
  MEDIA_VIDEO_PAYLOAD_BYTES,
  MEDIA_VIDEO_FRAME_WIDTH,
  MediaVideoPacketKind,
  decodeMediaVideoAckPayload,
  decodeMediaVideoPacket,
  decodeMediaVideoPacketFromI420,
  encodeMediaVideoAckPayload,
  encodeMediaVideoPacket,
  encodeMediaVideoPacketToI420,
} from '../src/media-video-codec.js';

describe('media-video packet codec', () => {
  it('round-trips a packet through an I420 video frame', () => {
    const payload = new TextEncoder().encode('hello over video');
    const packet = encodeMediaVideoPacket({
      kind: MediaVideoPacketKind.Data,
      seq: 42,
      ackSeq: 41,
      msgId: 7,
      fragIndex: 0,
      fragCount: 1,
      payload,
    });

    const frame = encodeMediaVideoPacketToI420(packet);
    const decodedPacketBytes = decodeMediaVideoPacketFromI420(
      frame,
      MEDIA_VIDEO_FRAME_WIDTH,
      MEDIA_VIDEO_FRAME_HEIGHT,
    );
    const decoded = decodeMediaVideoPacket(decodedPacketBytes);

    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe(MediaVideoPacketKind.Data);
    expect(decoded?.seq).toBe(42);
    expect(decoded?.ackSeq).toBe(41);
    expect(decoded?.msgId).toBe(7);
    expect(decoded?.fragIndex).toBe(0);
    expect(decoded?.fragCount).toBe(1);
    expect(new TextDecoder().decode(decoded?.payload)).toBe('hello over video');
  });

  it('rejects corrupted packets by CRC', () => {
    const packet = encodeMediaVideoPacket({
      kind: MediaVideoPacketKind.Ack,
      seq: 0,
      ackSeq: 11,
      msgId: 0,
      fragIndex: 0,
      fragCount: 0,
      payload: new Uint8Array(),
    });
    packet[20] = packet[20]! ^ 0xff;
    expect(decodeMediaVideoPacket(packet)).toBeNull();
  });

  it('round-trips a max-size packet through an I420 video frame', () => {
    const payload = new Uint8Array(MEDIA_VIDEO_PAYLOAD_BYTES);
    for (let i = 0; i < payload.byteLength; i += 1) payload[i] = i & 0xff;
    const packet = encodeMediaVideoPacket({
      kind: MediaVideoPacketKind.Data,
      seq: 500,
      ackSeq: 499,
      msgId: 9,
      fragIndex: 1,
      fragCount: 2,
      payload,
    });

    const frame = encodeMediaVideoPacketToI420(packet);
    const decoded = decodeMediaVideoPacket(decodeMediaVideoPacketFromI420(
      frame,
      MEDIA_VIDEO_FRAME_WIDTH,
      MEDIA_VIDEO_FRAME_HEIGHT,
    ));

    expect(decoded?.payload).toEqual(payload);
  });

  it('encodes ACK batches as uint16 sequence lists', () => {
    const payload = encodeMediaVideoAckPayload([1, 255, 1024, 65535]);
    expect(decodeMediaVideoAckPayload(payload)).toEqual([1, 255, 1024, 65535]);
  });
});
