import { afterEach, describe, expect, it } from 'vitest';
import { NativeBaleSidecar } from '../src/bale/native-sidecar.js';
import { ChatType, PeerType, type DialogPeerData, type HistoryMessage } from '../src/bale/messages.js';

describe('NativeBaleSidecar', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('does not drop new messages that share the same Bale timestamp', async () => {
    const peer = { type: PeerType.PRIVATE, id: 2n };
    const dialogs: DialogPeerData[] = [{
      peer,
      unreadCount: 0n,
      sortDate: 1000n,
      senderId: 2n,
      messageId: 2n,
      date: 1000n,
      content: { text: '__WT_FRAME__ignored' },
    }];
    const historyBatches: HistoryMessage[][] = [
      [{
        senderId: 2n,
        messageId: 1n,
        date: 1000n,
        content: { text: '__WT_FRAME__first' },
      }],
      [
        {
          senderId: 2n,
          messageId: 1n,
          date: 1000n,
          content: { text: '__WT_FRAME__first' },
        },
        {
          senderId: 2n,
          messageId: 2n,
          date: 1000n,
          content: { text: '__WT_FRAME__second' },
        },
      ],
    ];
    const loadHistoryDates: bigint[] = [];
    const fakeClient = {
      currentSession() {
        return {
          jwt: 'jwt',
          userId: 1n,
          userName: 'tester',
          userAccessHash: 1n,
        };
      },
      async loadDialogs() {
        return dialogs;
      },
      async loadHistory(_peer: unknown, _chatType: ChatType, offsetDate: bigint) {
        loadHistoryDates.push(offsetDate);
        return historyBatches.shift() ?? [];
      },
      async sendTextMessage() {
        return 99n;
      },
    };

    const sidecar = new NativeBaleSidecar({
      client: fakeClient as never,
      pollIntervalMs: 60_000,
    });
    cleanups.push(() => sidecar.close());

    const mutable = sidecar as unknown as {
      peers: Map<string, {
        peer: typeof peer;
        sinceDate: bigint;
        seenMessageIdsAtSinceDate: Set<string>;
        initialized: boolean;
      }>;
      pollOnce: () => Promise<void>;
    };
    mutable.peers.set(`${peer.type}:${peer.id}`, {
      peer,
      sinceDate: 999n,
      seenMessageIdsAtSinceDate: new Set(),
      initialized: true,
    });

    const seenTexts: string[] = [];
    sidecar.onMessage((msg) => {
      seenTexts.push(msg.text ?? '');
    });

    await mutable.pollOnce();
    await mutable.pollOnce();

    expect(seenTexts).toEqual(['__WT_FRAME__first', '__WT_FRAME__second']);
    expect(loadHistoryDates).toEqual([998n, 999n]);
  });
});
