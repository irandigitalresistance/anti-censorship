import { describe, expect, it } from 'vitest';
import { Writer } from '../src/bale/proto.js';
import { decodeIncomingCallEvent } from '../src/bale/update-socket.js';

describe('decodeIncomingCallEvent', () => {
  it('extracts incoming call pushes from Bale WS update frames', () => {
    const push = new Writer();
    push.int(1, 2215627092896861984n);
    push.string(3, 'room-uuid-1');
    push.message(4, (m) => m.string(1, 'wss://meet-gwe.ble.ir'));

    const update = new Writer();
    update.bytes_(52807, push.toBytes());

    const updateBody = new Writer();
    updateBody.bytes_(1, update.toBytes());
    updateBody.int(4, 1776000000000n);

    const frame = new Writer();
    frame.message(2, (m) => m.bytes_(1, updateBody.toBytes()));

    expect(decodeIncomingCallEvent(frame.toBytes())).toEqual({
      callId: 2215627092896861984n,
      roomUuid: 'room-uuid-1',
      baseUrl: 'wss://meet-gwe.ble.ir',
      dateMs: 1776000000000,
    });
  });

  it('unwraps Bale incoming-call payloads wrapped inside field 1', () => {
    const inner = new Writer();
    inner.int(1, -2179037374721343145n);
    inner.string(3, 'wrapped-room');
    inner.message(4, (m) => m.string(1, 'wss://meet-gwe.ble.ir'));

    const update = new Writer();
    update.message(52807, (m) => m.bytes_(1, inner.toBytes()));

    const updateBody = new Writer();
    updateBody.bytes_(1, update.toBytes());
    updateBody.int(4, 1776000001234n);

    const frame = new Writer();
    frame.message(2, (m) => m.bytes_(1, updateBody.toBytes()));

    expect(decodeIncomingCallEvent(frame.toBytes())).toEqual({
      callId: -2179037374721343145n,
      roomUuid: 'wrapped-room',
      baseUrl: 'wss://meet-gwe.ble.ir',
      dateMs: 1776000001234,
    });
  });

  it('ignores unrelated Bale WS frames', () => {
    const frame = new Writer();
    frame.message(4, (m) => m.int(1, 7));
    expect(decodeIncomingCallEvent(frame.toBytes())).toBeNull();
  });
});
