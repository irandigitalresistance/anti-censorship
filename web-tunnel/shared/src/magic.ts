export const MAGIC_REQ = '__WT_REQ__';
export const MAGIC_OK = '__WT_OK__';
export const MAGIC_DENY = '__WT_DENY__';
export const MAGIC_FRAME = '__WT_FRAME__';
export const MAGIC_FRAME_V2 = '__WT2_FRAME__';
/** Sent by the CLIENT after `Meet.StartCall` so the server-side peer learns
 *  the `call_id` and can `Meet.AcceptCall` it. Body is the decimal call_id. */
export const MAGIC_MEET_OFFER = '__WT_MEET__';

export type MagicMessage =
  | { kind: 'req'; body: Uint8Array }
  | { kind: 'ok'; body: Uint8Array }
  | { kind: 'deny'; reason: string }
  | { kind: 'frame'; body: Uint8Array; sessionTag: string | null; protocolVersion: 1 | 2 }
  | { kind: 'meet-offer'; callId: bigint }
  | { kind: 'chat'; text: string };

export function buildReq(body: Uint8Array): string {
  return MAGIC_REQ + b64url(body);
}
export function buildOk(body: Uint8Array): string {
  return MAGIC_OK + b64url(body);
}
export function buildDeny(reason = ''): string {
  return MAGIC_DENY + reason;
}
export function buildFrameMessage(body: Uint8Array, sessionTag?: string | null): string {
  if (sessionTag && sessionTag.length > 0) {
    return MAGIC_FRAME + sessionTag + '.' + b64url(body);
  }
  return MAGIC_FRAME + b64url(body);
}

export function buildFrameMessageV2(body: Uint8Array, sessionTag?: string | null): string {
  if (sessionTag && sessionTag.length > 0) {
    return MAGIC_FRAME_V2 + sessionTag + '.' + b64url(body);
  }
  return MAGIC_FRAME_V2 + b64url(body);
}

export function buildMeetOffer(callId: bigint): string {
  return MAGIC_MEET_OFFER + callId.toString(10);
}

export function parseMagic(text: string): MagicMessage {
  if (text.startsWith(MAGIC_REQ)) return { kind: 'req', body: unb64url(text.slice(MAGIC_REQ.length)) };
  if (text.startsWith(MAGIC_OK)) return { kind: 'ok', body: unb64url(text.slice(MAGIC_OK.length)) };
  if (text.startsWith(MAGIC_DENY)) return { kind: 'deny', reason: text.slice(MAGIC_DENY.length) };
  if (text.startsWith(MAGIC_FRAME)) {
    const payload = text.slice(MAGIC_FRAME.length);
    const dot = payload.indexOf('.');
    if (dot > 0) {
      const sessionTag = payload.slice(0, dot);
      const body = unb64url(payload.slice(dot + 1));
      return { kind: 'frame', body, sessionTag, protocolVersion: 1 };
    }
    return { kind: 'frame', body: unb64url(payload), sessionTag: null, protocolVersion: 1 };
  }
  if (text.startsWith(MAGIC_FRAME_V2)) {
    const payload = text.slice(MAGIC_FRAME_V2.length);
    const dot = payload.indexOf('.');
    if (dot > 0) {
      const sessionTag = payload.slice(0, dot);
      const body = unb64url(payload.slice(dot + 1));
      return { kind: 'frame', body, sessionTag, protocolVersion: 2 };
    }
    return { kind: 'frame', body: unb64url(payload), sessionTag: null, protocolVersion: 2 };
  }
  if (text.startsWith(MAGIC_MEET_OFFER)) {
    const s = text.slice(MAGIC_MEET_OFFER.length).trim();
    try { return { kind: 'meet-offer', callId: BigInt(s) }; } catch { /* fall through */ }
  }
  return { kind: 'chat', text };
}

function b64url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function unb64url(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((s.length + 3) % 4);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
