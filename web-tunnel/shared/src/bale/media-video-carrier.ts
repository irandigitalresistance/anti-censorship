import type { LivekitConnectContext } from '../livekit-factory.js';
import {
  MEDIA_VIDEO_FRAME_HEIGHT,
  MEDIA_VIDEO_FRAME_WIDTH,
  MEDIA_VIDEO_PAYLOAD_BYTES,
  MediaVideoPacketKind,
  decodeMediaVideoAckPayload,
  decodeMediaVideoPacket,
  decodeMediaVideoPacketFromI420,
  encodeMediaVideoAckPayload,
  encodeMediaVideoPacket,
  encodeMediaVideoPacketToI420,
  type MediaVideoPacket,
} from '../media-video-codec.js';

const FRAME_INTERVAL_MS = 33;
const ACK_INTERVAL_MS = 50;
const ACK_REPEAT_COUNT = 6;
const MAX_PENDING_PACKETS = 192;
const RETRANSMIT_MS = 350;
const TRACK_NAME = 'wt-media-packets';

type MessageHandler = (bytes: Uint8Array, fromIdentity: string) => void;

interface PendingFragment {
  packet: MediaVideoPacket;
  lastSentAt: number;
  sendCount: number;
  order: number;
}

interface FragmentSet {
  readonly fragCount: number;
  readonly received: Map<number, Uint8Array>;
  readonly fromIdentity: string;
}

export interface RtcNodeVideoPacketCarrier {
  send(bytes: Uint8Array): Promise<void>;
  onMessage(cb: MessageHandler): () => void;
  close(reason?: string): Promise<void>;
}

export async function makeRtcNodeVideoPacketCarrier(
  sdk: any,
  room: any,
  ctx: LivekitConnectContext,
): Promise<RtcNodeVideoPacketCarrier> {
  const localIdentity = room.localParticipant?.identity ?? ctx.identity;
  const source = new sdk.VideoSource(MEDIA_VIDEO_FRAME_WIDTH, MEDIA_VIDEO_FRAME_HEIGHT);
  const track = sdk.LocalVideoTrack.createVideoTrack(TRACK_NAME, source);
  const publishOptions = new sdk.TrackPublishOptions();
  publishOptions.source = sdk.TrackSource.SOURCE_CAMERA;
  publishOptions.name = TRACK_NAME;

  await room.localParticipant.publishTrack(track, publishOptions);

  const handlers = new Set<MessageHandler>();
  const streams = new Set<{ cancel: () => void }>();
  const partialMessages = new Map<string, FragmentSet>();
  const completedMessages = new Map<string, Map<number, Uint8Array>>();
  const expectedMsgIds = new Map<string, number>();
  const seenDataSeqs: number[] = [];
  const pendingFragments = new Map<number, PendingFragment>();
  const ackRepeats = new Map<number, number>();
  const capacityWaiters: Array<() => void> = [];
  let closed = false;
  let nextSeq = 1;
  let nextMsgId = 1;
  let nextOrder = 1;
  let lastAckSeq: number | null = null;
  let lastAckFrameAt = 0;

  const publishFrame = (packet: MediaVideoPacket): void => {
    const packetBytes = encodeMediaVideoPacket(packet);
    const frameBytes = encodeMediaVideoPacketToI420(packetBytes);
    const frame = new sdk.VideoFrame(
      frameBytes,
      MEDIA_VIDEO_FRAME_WIDTH,
      MEDIA_VIDEO_FRAME_HEIGHT,
      sdk.VideoBufferType.I420,
    );
    source.captureFrame(frame);
  };

  const ticker = setInterval(() => {
    if (closed) return;
    try {
      publishFrame(selectFramePacket());
    } catch {
      // A failed synthetic frame should not tear down the tunnel; later frames
      // can still carry retransmits.
    }
  }, FRAME_INTERVAL_MS);
  if (typeof (ticker as unknown as { unref?: () => void }).unref === 'function') {
    (ticker as unknown as { unref: () => void }).unref();
  }

  const onTrackSubscribed = (remoteTrack: any, _publication: any, participant: any) => {
    const fromIdentity = participant?.identity ?? 'unknown';
    if (fromIdentity === localIdentity) return;
    const kind = remoteTrack?.kind;
    const isVideo = kind === sdk.TrackKind?.KIND_VIDEO || String(kind).toLowerCase().includes('video');
    if (!isVideo) return;
    startVideoReader(sdk, remoteTrack, fromIdentity, {
      closed: () => closed,
      onPacket: (packet) => handlePacket(packet, fromIdentity),
      onCancel: (cancel) => streams.add({ cancel }),
    });
  };

  room.on(sdk.RoomEvent.TrackSubscribed, onTrackSubscribed);

  for (const participant of room.remoteParticipants?.values?.() ?? []) {
    for (const publication of participant.trackPublications?.values?.() ?? []) {
      if (publication.track) onTrackSubscribed(publication.track, publication, participant);
    }
  }

  function selectFramePacket(): MediaVideoPacket {
    const now = Date.now();
    const pending = selectPendingFragment(now);
    const ackDue = ackRepeats.size > 0 && (now - lastAckFrameAt >= ACK_INTERVAL_MS || !pending);
    if (ackDue) return buildAckPacket(now, true);
    if (pending) {
      pending.lastSentAt = now;
      pending.sendCount += 1;
      return { ...pending.packet, ackSeq: lastAckSeq };
    }
    return buildAckPacket(now, false);
  }

  function selectPendingFragment(now: number): PendingFragment | null {
    let retry: PendingFragment | null = null;
    for (const pending of pendingFragments.values()) {
      if (pending.lastSentAt === 0) return pending;
      if (now - pending.lastSentAt < RETRANSMIT_MS) continue;
      if (!retry || pending.lastSentAt < retry.lastSentAt || (
        pending.lastSentAt === retry.lastSentAt && pending.order < retry.order
      )) {
        retry = pending;
      }
    }
    return retry;
  }

  function buildAckPacket(now: number, consumeRepeats: boolean): MediaVideoPacket {
    const maxSeqs = Math.floor(MEDIA_VIDEO_PAYLOAD_BYTES / 2);
    const seqs: number[] = [];
    if (consumeRepeats) {
      for (const [seq, repeats] of ackRepeats) {
        seqs.push(seq);
        if (repeats <= 1) ackRepeats.delete(seq);
        else ackRepeats.set(seq, repeats - 1);
        if (seqs.length >= maxSeqs) break;
      }
      lastAckFrameAt = now;
    }
    return {
      kind: MediaVideoPacketKind.Ack,
      seq: 0,
      ackSeq: lastAckSeq,
      msgId: 0,
      fragIndex: 0,
      fragCount: 0,
      payload: encodeMediaVideoAckPayload(seqs),
    };
  }

  function handlePacket(packet: MediaVideoPacket, fromIdentity: string): void {
    if (closed) return;
    if (packet.ackSeq != null) markAcked(packet.ackSeq);
    if (packet.kind === MediaVideoPacketKind.Ack) {
      for (const seq of decodeMediaVideoAckPayload(packet.payload)) markAcked(seq);
      return;
    }
    if (packet.kind !== MediaVideoPacketKind.Data) return;
    queueAck(packet.seq);
    if (hasSeenSeq(seenDataSeqs, packet.seq)) return;
    rememberSeq(seenDataSeqs, packet.seq);
    if (packet.fragCount === 0 || packet.fragIndex >= packet.fragCount) return;
    const key = `${fromIdentity}:${packet.msgId}`;
    let partial = partialMessages.get(key);
    if (!partial || partial.fragCount !== packet.fragCount) {
      partial = { fragCount: packet.fragCount, received: new Map(), fromIdentity };
      partialMessages.set(key, partial);
    }
    partial.received.set(packet.fragIndex, packet.payload);
    if (partial.received.size !== partial.fragCount) return;
    partialMessages.delete(key);
    const total = Array.from(partial.received.values()).reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < partial.fragCount; i += 1) {
      const part = partial.received.get(i);
      if (!part) return;
      out.set(part, offset);
      offset += part.byteLength;
    }
    bufferCompletedMessage(partial.fromIdentity, packet.msgId, out);
  }

  function queueAck(seq: number): void {
    lastAckSeq = seq;
    ackRepeats.set(seq, ACK_REPEAT_COUNT);
  }

  function markAcked(seq: number): void {
    if (pendingFragments.delete(seq)) notifyCapacityWaiters();
  }

  function bufferCompletedMessage(fromIdentity: string, msgId: number, bytes: Uint8Array): void {
    let expected = expectedMsgIds.get(fromIdentity) ?? 1;
    let completed = completedMessages.get(fromIdentity);
    if (!completed) {
      completed = new Map();
      completedMessages.set(fromIdentity, completed);
    }
    completed.set(msgId, bytes);
    for (;;) {
      const next = completed.get(expected);
      if (!next) break;
      completed.delete(expected);
      for (const cb of handlers) cb(next, fromIdentity);
      expected = nextU16(expected);
    }
    expectedMsgIds.set(fromIdentity, expected);
  }

  async function enqueueBytes(bytes: Uint8Array): Promise<void> {
    if (closed) throw new Error('media-video carrier closed');
    const msgId = nextMsgId;
    nextMsgId = nextU16(nextMsgId);
    const chunks = chunk(bytes, MEDIA_VIDEO_PAYLOAD_BYTES);
    if (chunks.length > 0xff) {
      throw new RangeError(`media-video message has too many fragments (${chunks.length} > 255)`);
    }
    for (let i = 0; i < chunks.length; i += 1) {
      await waitForCapacity();
      if (closed) throw new Error('media-video carrier closed');
      const seq = nextSeq;
      nextSeq = nextU16(nextSeq);
      pendingFragments.set(seq, {
        packet: {
          kind: MediaVideoPacketKind.Data,
          seq,
          ackSeq: lastAckSeq,
          msgId,
          fragIndex: i,
          fragCount: chunks.length,
          payload: chunks[i]!,
        },
        lastSentAt: 0,
        sendCount: 0,
        order: nextOrder++,
      });
    }
  }

  async function waitForCapacity(): Promise<void> {
    while (!closed && pendingFragments.size >= MAX_PENDING_PACKETS) {
      await new Promise<void>((resolve) => capacityWaiters.push(resolve));
    }
    if (closed) throw new Error('media-video carrier closed');
  }

  function notifyCapacityWaiters(): void {
    while (pendingFragments.size < MAX_PENDING_PACKETS && capacityWaiters.length > 0) {
      capacityWaiters.shift()?.();
    }
  }

  return {
    send(bytes) {
      return enqueueBytes(bytes.slice());
    },
    onMessage(cb) {
      handlers.add(cb);
      return () => handlers.delete(cb);
    },
    async close(reason = 'media-video carrier closed') {
      if (closed) return;
      closed = true;
      clearInterval(ticker);
      room.off?.(sdk.RoomEvent.TrackSubscribed, onTrackSubscribed);
      for (const stream of streams) stream.cancel();
      streams.clear();
      pendingFragments.clear();
      ackRepeats.clear();
      notifyCapacityWaiters();
      await Promise.allSettled([
        track.close?.(),
        source.close?.(),
      ]);
    },
  };
}

function startVideoReader(
  sdk: any,
  remoteTrack: any,
  fromIdentity: string,
  opts: {
    closed: () => boolean;
    onPacket: (packet: MediaVideoPacket, fromIdentity: string) => void;
    onCancel: (cancel: () => void) => void;
  },
): void {
  const stream = new sdk.VideoStream(remoteTrack);
  const reader = stream.getReader();
  let cancelled = false;
  opts.onCancel(() => {
    cancelled = true;
    reader.cancel().catch(() => undefined);
  });
  void (async () => {
    while (!opts.closed() && !cancelled) {
      const { value, done } = await reader.read();
      if (done || !value) return;
      let frame = value.frame;
      try {
        if (frame.type !== sdk.VideoBufferType.I420) frame = frame.convert(sdk.VideoBufferType.I420);
        const raw = decodeMediaVideoPacketFromI420(frame.data, frame.width, frame.height);
        const packet = decodeMediaVideoPacket(raw);
        if (packet) opts.onPacket(packet, fromIdentity);
      } catch {
        // Ignore frames that are not our synthetic packet video.
      }
    }
  })().catch(() => undefined);
}

function chunk(bytes: Uint8Array, max: number): Uint8Array[] {
  if (bytes.byteLength === 0) return [new Uint8Array()];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += max) {
    out.push(bytes.slice(i, Math.min(bytes.byteLength, i + max)));
  }
  return out;
}

function hasSeenSeq(seqs: number[], seq: number): boolean {
  return seqs.includes(seq);
}

function rememberSeq(seqs: number[], seq: number): void {
  seqs.push(seq);
  if (seqs.length > 8192) seqs.splice(0, seqs.length - 8192);
}

function nextU16(value: number): number {
  const next = (value + 1) & 0xffff;
  return next === 0 ? 1 : next;
}
