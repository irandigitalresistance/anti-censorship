import type { ISidecar, Peer } from './sidecar.js';
import { buildFrameMessage, buildFrameMessageV2, parseMagic } from './magic.js';
import type { Transport } from './transport.js';

export interface ChatTransportOptions {
  sidecar: ISidecar;
  peer: Peer;
  /** Defaults to v1. Pass 2 for strict v2 carriers. */
  protocolVersion?: 1 | 2;
  /**
   * Optional tunnel session tag. When set, only frame envelopes carrying the
   * same tag are accepted. This lets fresh tunnels ignore stale frame history
   * left in the chat from earlier sessions.
   */
  sessionTag?: string;
  /**
   * Optional: called when an inbound chat-audit message arrives from the peer
   * (anything that isn't a `__WT_FRAME__` envelope). If unset, non-frame chat
   * messages are dropped.
   */
  onChat?: (text: string) => void;
}

export function makeChatTransport(opts: ChatTransportOptions): Transport {
  const { sidecar, peer, onChat, sessionTag } = opts;
  const protocolVersion = opts.protocolVersion ?? 1;
  let onMessage: ((bytes: Uint8Array) => void) | null = null;
  let onClose: ((reason: string) => void) | null = null;
  let closed = false;

  const offMsg = sidecar.onMessage((msg) => {
    if (closed) return;
    if (msg.chat.chatId !== peer.chatId || msg.chat.chatType !== peer.chatType) return;
    if (msg.text == null) return;
    const parsed = parseMagic(msg.text);
    if (parsed.kind === 'frame') {
      if (parsed.protocolVersion !== protocolVersion) return;
      if (sessionTag && parsed.sessionTag !== sessionTag) return;
      onMessage?.(parsed.body);
      return;
    }
    if (parsed.kind === 'chat') {
      onChat?.(parsed.text);
    }
  });
  const offClose = sidecar.onClose((reason) => {
    if (closed) return;
    closed = true;
    onClose?.(reason);
  });

  return {
    async send(bytes) {
      if (closed) return;
      try {
        const payload = protocolVersion === 2
          ? buildFrameMessageV2(bytes, sessionTag)
          : buildFrameMessage(bytes, sessionTag);
        await sidecar.sendMessage(peer, payload);
      } catch (e) {
        if (closed) return;
        closed = true;
        onClose?.(`send failed: ${(e as Error).message}`);
      }
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
      if (closed) cb('already closed');
    },
    close(reason = 'chat-transport closed') {
      if (closed) return;
      closed = true;
      offMsg();
      offClose();
      onClose?.(reason);
    },
  };
}
