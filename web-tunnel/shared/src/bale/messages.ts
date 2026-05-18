// Bale protobuf message encoders/decoders for the RPCs we need.
// Field numbers extracted from aiobale's pydantic models (alias="N" meta).

import { Reader, Writer, decodeString, toSignedInt64 } from './proto.js';

// ---------------- StartPhoneAuth ----------------

export interface StartPhoneAuthRequest {
  phoneNumber: number | bigint; // field 1
  appId: number; // field 2
  appKey: string; // field 3
  deviceHash: string; // field 4
  deviceTitle: string; // field 5
  sendCodeType: number; // field 9 (enum: 0=DEFAULT)
  options?: Record<number, number>; // field 10 (map<int32,int32>); default {0:1}
}

export function encodeStartPhoneAuth(req: StartPhoneAuthRequest): Uint8Array {
  const w = new Writer();
  w.int(1, req.phoneNumber);
  w.int(2, req.appId);
  w.string(3, req.appKey);
  w.string(4, req.deviceHash);
  w.string(5, req.deviceTitle);
  w.int(9, req.sendCodeType);
  const options = req.options ?? { 0: 1 };
  for (const [k, v] of Object.entries(options)) {
    w.message(10, (m) => {
      m.int(1, Number(k));
      m.int(2, v);
    });
  }
  return w.toBytes();
}

export interface PhoneAuthResponse {
  transactionHash: string; // 1
  isRegistered: boolean; // 2
  sentCodeType?: number; // 5
  codeExpirationDateMs?: bigint; // 6 (Value message, field 1)
  nextSendCodeType?: number; // 7
  codeTimeoutSec?: bigint; // 8 (Value message, field 1)
}

export function decodePhoneAuthResponse(bytes: Uint8Array): PhoneAuthResponse {
  const out: PhoneAuthResponse = {
    transactionHash: '',
    isRegistered: false,
  };
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 1:
        if (f.wireType === 2) out.transactionHash = decodeString(f.bytes!);
        break;
      case 2:
        if (f.wireType === 0) out.isRegistered = f.varint === 1n;
        break;
      case 5:
        if (f.wireType === 0) out.sentCodeType = Number(f.varint);
        break;
      case 6:
        if (f.wireType === 2) out.codeExpirationDateMs = decodeValueInt(f.bytes!);
        break;
      case 7:
        if (f.wireType === 0) out.nextSendCodeType = Number(f.varint);
        break;
      case 8:
        if (f.wireType === 2) out.codeTimeoutSec = decodeValueInt(f.bytes!);
        break;
    }
  }
  return out;
}

function decodeValueInt(bytes: Uint8Array): bigint | undefined {
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 1 && f.wireType === 0) return toSignedInt64(f.varint!);
  }
  return undefined;
}

// ---------------- ValidateCode ----------------

export interface ValidateCodeRequest {
  transactionHash: string; // 1
  code: string; // 2
  /** field 3 — always {"1": 1} per aiobale default. */
  isJwtOptions?: Record<number, number>;
}

export function encodeValidateCode(req: ValidateCodeRequest): Uint8Array {
  const w = new Writer();
  w.string(1, req.transactionHash);
  w.string(2, req.code);
  const opts = req.isJwtOptions ?? { 1: 1 };
  for (const [k, v] of Object.entries(opts)) {
    w.message(3, (m) => {
      m.int(1, Number(k));
      m.int(2, v);
    });
  }
  return w.toBytes();
}

export interface ValidateCodeResponse {
  user?: UserAuth; // 2
  jwt?: string; // 4 (StringValue, field 1)
}

export interface UserAuth {
  id: bigint; // 1
  accessHash: bigint; // 2
  name: string; // 3
  username?: string; // 9 (StringValue, field 1)
}

export function decodeValidateCodeResponse(bytes: Uint8Array): ValidateCodeResponse {
  const out: ValidateCodeResponse = {};
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 2 && f.wireType === 2) {
      out.user = decodeUserAuth(f.bytes!);
    } else if (f.fieldNumber === 4 && f.wireType === 2) {
      out.jwt = decodeStringValue(f.bytes!);
    }
  }
  return out;
}

export function decodeUserAuth(bytes: Uint8Array): UserAuth {
  const out: UserAuth = { id: 0n, accessHash: -1n, name: '' };
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 1:
        if (f.wireType === 0) out.id = toSignedInt64(f.varint!);
        break;
      case 2:
        if (f.wireType === 0) out.accessHash = toSignedInt64(f.varint!);
        break;
      case 3:
        if (f.wireType === 2) out.name = decodeString(f.bytes!);
        break;
      case 9:
        if (f.wireType === 2) out.username = decodeStringValue(f.bytes!);
        break;
    }
  }
  return out;
}

export function decodeStringValue(bytes: Uint8Array): string {
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 1 && f.wireType === 2) return decodeString(f.bytes!);
  }
  return '';
}

// ---------------- Peer / Chat ----------------

export enum PeerType {
  UNKNOWN = 0,
  PRIVATE = 1,
  GROUP = 2,
}

export enum ChatType {
  UNKNOWN = 0,
  PRIVATE = 1,
  GROUP = 2,
  CHANNEL = 3,
  BOT = 4,
  SUPER_GROUP = 5,
}

export interface Peer {
  type: PeerType; // 1
  id: bigint; // 2
  accessHash?: bigint; // 3
}

export function encodePeer(p: Peer): Uint8Array {
  const w = new Writer();
  w.int(1, p.type);
  w.int(2, p.id);
  if (p.accessHash !== undefined) w.int(3, p.accessHash);
  return w.toBytes();
}

export function decodePeer(bytes: Uint8Array): Peer {
  const p: Peer = { type: PeerType.UNKNOWN, id: 0n };
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 1:
        if (f.wireType === 0) p.type = Number(f.varint);
        break;
      case 2:
        if (f.wireType === 0) p.id = toSignedInt64(f.varint!);
        break;
      case 3:
        if (f.wireType === 0) p.accessHash = toSignedInt64(f.varint!);
        break;
    }
  }
  return p;
}

export interface Chat {
  type: ChatType; // 1
  id: bigint; // 2
}

export function encodeChat(c: Chat): Uint8Array {
  const w = new Writer();
  w.int(1, c.type);
  w.int(2, c.id);
  return w.toBytes();
}

// ---------------- MessageContent ----------------

export interface MessageContent {
  text?: string; // field 15 is TextMessage, whose field 1 is the string
  empty?: boolean; // field 5
}

export function encodeMessageContent(c: MessageContent): Uint8Array {
  const w = new Writer();
  if (c.text !== undefined) {
    w.message(15, (m) => m.string(1, c.text!));
  }
  if (c.empty) w.int(5, 1);
  return w.toBytes();
}

export function decodeMessageContent(bytes: Uint8Array): MessageContent {
  const out: MessageContent = {};
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 15:
        if (f.wireType === 2) {
          for (const inner of new Reader(f.bytes!).fields()) {
            if (inner.fieldNumber === 1 && inner.wireType === 2) {
              out.text = decodeString(inner.bytes!);
            }
          }
        }
        break;
      case 5:
        out.empty = true;
        break;
    }
  }
  return out;
}

// ---------------- SendMessage ----------------

export interface SendMessageRequest {
  peer: Peer; // 1
  messageId: bigint; // 2 — randomly generated rid (int64)
  content: MessageContent; // 3
  chat: Chat; // 6
}

export function encodeSendMessage(req: SendMessageRequest): Uint8Array {
  const w = new Writer();
  w.bytes_(1, encodePeer(req.peer));
  w.int(2, req.messageId);
  w.bytes_(3, encodeMessageContent(req.content));
  w.bytes_(6, encodeChat(req.chat));
  return w.toBytes();
}

/** SendMessage response is largely unused by us (we just care that it succeeded). */
export interface SendMessageResponse {
  date?: bigint;
}

export function decodeSendMessageResponse(bytes: Uint8Array): SendMessageResponse {
  const out: SendMessageResponse = {};
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 1 && f.wireType === 0) out.date = toSignedInt64(f.varint!);
  }
  return out;
}

// ---------------- LoadDialogs ----------------

export interface LoadDialogsRequest {
  offsetDate: bigint; // 1 — -1 means "latest"
  limit: number; // 2
  excludePinned: boolean; // 5
}

export function encodeLoadDialogs(req: LoadDialogsRequest): Uint8Array {
  const w = new Writer();
  w.int(1, req.offsetDate);
  w.int(2, req.limit);
  w.int(5, req.excludePinned ? 1 : 0);
  return w.toBytes();
}

export interface DialogPeerData {
  peer: Peer;
  unreadCount: bigint;
  sortDate: bigint;
  senderId: bigint;
  messageId: bigint;
  date: bigint;
  content: MessageContent;
}

export interface LoadDialogsResponse {
  dialogs: DialogPeerData[];
}

export function decodeLoadDialogsResponse(bytes: Uint8Array): LoadDialogsResponse {
  const dialogs: DialogPeerData[] = [];
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 3 && f.wireType === 2) {
      dialogs.push(decodePeerData(f.bytes!));
    }
  }
  return { dialogs };
}

function decodePeerData(bytes: Uint8Array): DialogPeerData {
  const out: DialogPeerData = {
    peer: { type: PeerType.UNKNOWN, id: 0n },
    unreadCount: 0n,
    sortDate: 0n,
    senderId: 0n,
    messageId: 0n,
    date: 0n,
    content: {},
  };
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 1:
        if (f.wireType === 2) out.peer = decodePeer(f.bytes!);
        break;
      case 2:
        if (f.wireType === 0) out.unreadCount = toSignedInt64(f.varint!);
        break;
      case 3:
        if (f.wireType === 0) out.sortDate = toSignedInt64(f.varint!);
        break;
      case 4:
        if (f.wireType === 0) out.senderId = toSignedInt64(f.varint!);
        break;
      case 5:
        if (f.wireType === 0) out.messageId = toSignedInt64(f.varint!);
        break;
      case 6:
        if (f.wireType === 0) out.date = toSignedInt64(f.varint!);
        break;
      case 7:
        if (f.wireType === 2) out.content = decodeMessageContent(f.bytes!);
        break;
    }
  }
  return out;
}

// ---------------- LoadHistory ----------------
// Fetches messages for a peer from a given date. Fields from aiobale's
// methods/messaging/load_history.py: 1=peer, 2=offset_date, 4=load_mode, 5=limit.

export enum ListLoadMode {
  UNKNOWN = 0,
  FORWARD = 1,
  BACKWARD = 2,
  BOTH = 3,
}

export interface LoadHistoryRequest {
  peer: Peer;
  date: bigint; // offset_date (ms epoch); 0 means newest
  loadMode: ListLoadMode;
  limit: number;
}

export function encodeLoadHistory(req: LoadHistoryRequest): Uint8Array {
  const w = new Writer();
  w.bytes_(1, encodePeer(req.peer));
  w.int(2, req.date);
  w.int(4, req.loadMode);
  w.int(5, req.limit);
  return w.toBytes();
}

// MessageData fields (aiobale/types/message_data.py):
//   1=sender_id, 2=message_id, 3=date, 4=content, 8=replied_to, 12=edited_at.
export interface HistoryMessage {
  senderId: bigint;
  messageId: bigint;
  date: bigint;
  content: MessageContent;
}

export interface LoadHistoryResponse {
  messages: HistoryMessage[];
}

export function decodeLoadHistoryResponse(bytes: Uint8Array): LoadHistoryResponse {
  const messages: HistoryMessage[] = [];
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 1 && f.wireType === 2) {
      messages.push(decodeHistoryMessage(f.bytes!));
    }
  }
  return { messages };
}

function decodeHistoryMessage(bytes: Uint8Array): HistoryMessage {
  const out: HistoryMessage = {
    senderId: 0n,
    messageId: 0n,
    date: 0n,
    content: {},
  };
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 1:
        if (f.wireType === 0) out.senderId = toSignedInt64(f.varint!);
        break;
      case 2:
        if (f.wireType === 0) out.messageId = toSignedInt64(f.varint!);
        break;
      case 3:
        if (f.wireType === 0) out.date = toSignedInt64(f.varint!);
        break;
      case 4:
        if (f.wireType === 2) out.content = decodeMessageContent(f.bytes!);
        break;
    }
  }
  return out;
}

// ---------------- LoadUsers ----------------

export interface InfoPeer {
  id: bigint;
  type?: ChatType;
}

export interface LoadUsersRequest {
  peers: InfoPeer[];
}

export function encodeLoadUsers(req: LoadUsersRequest): Uint8Array {
  const w = new Writer();
  for (const p of req.peers) {
    w.message(1, (m) => {
      m.int(1, p.id);
      if (p.type !== undefined) m.int(2, p.type);
    });
  }
  return w.toBytes();
}

export interface BaleUser {
  id: bigint;
  accessHash: bigint;
  name: string;
  username?: string;
}

export interface LoadUsersResponse {
  users: BaleUser[];
}

export function decodeLoadUsersResponse(bytes: Uint8Array): LoadUsersResponse {
  const users: BaleUser[] = [];
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 1 && f.wireType === 2) {
      users.push(decodeBaleUser(f.bytes!));
    }
  }
  return { users };
}

function decodeBaleUser(bytes: Uint8Array): BaleUser {
  const out: BaleUser = { id: 0n, accessHash: 0n, name: '' };
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 1:
        if (f.wireType === 0) out.id = toSignedInt64(f.varint!);
        break;
      case 2:
        if (f.wireType === 0) out.accessHash = toSignedInt64(f.varint!);
        break;
      case 3:
        if (f.wireType === 2) out.name = decodeString(f.bytes!);
        break;
      case 9:
        if (f.wireType === 2) {
          const raw = f.bytes!;
          try {
            out.username = new TextDecoder('utf-8', { fatal: true }).decode(raw);
          } catch {
            for (const inner of new Reader(raw).fields()) {
              if (inner.fieldNumber === 1 && inner.wireType === 2) {
                out.username = new TextDecoder('utf-8', { fatal: false }).decode(inner.bytes!);
              }
            }
          }
        }
        break;
    }
  }
  return out;
}

// ---------------- Meet (voice/video call) ----------------
// Reverse-engineered from web.bale.ai's WebSocket-RPC frames (2026-04-22) —
// see probe/README.md for capture methodology. Bale's Meet service:
//   bale.meet.v1.Meet/StartCall    — initiate call, returns LiveKit URL+JWT
//   bale.meet.v1.Meet/DiscardCall  — hang up
//   bale.meet.v1.Meet/AcceptCall   — (not yet captured; needed by callee)
//   bale.meet.v1.Meet/GetCallState — poll call state

export interface StartCallRequest {
  peer: Peer;        // target user to call
  rid: bigint;       // random int64 request id (client-generated)
  mediaFlag?: number; // inner field 1; observed as 1 for normal call
}

export function encodeStartCall(req: StartCallRequest): Uint8Array {
  // The request wrapper has a single field at number 6 containing the inner
  // StartCallRequest body. Unusual but that's how the wire format goes.
  const w = new Writer();
  w.message(6, (m) => {
    m.bytes_(1, encodePeer(req.peer));
    m.int(2, req.rid);
    m.message(4, (inner) => {
      inner.int(1, req.mediaFlag ?? 1);
    });
  });
  return w.toBytes();
}

export interface StartCallResult {
  callId: bigint;      // Bale-internal call id (u64)
  jwt: string;          // LiveKit access_token (passed to SFU)
  roomUuid: string;     // LiveKit room name (also encoded inside the JWT)
  baseUrl: string;      // e.g. "wss://meet-gwbm6.ble.ir" (SFU endpoint)
  startedAtMs: bigint;
  serverAuthTs: bigint;
  peer: Peer;           // echo of caller
  state: number;        // observed: 1
}

/** StartCall response wrapping: `{ field 1: StartCallResult, field 3: unknown }`. */
export function decodeStartCallResponse(bytes: Uint8Array): StartCallResult {
  let result: StartCallResult | null = null;
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 1 && f.wireType === 2) {
      result = decodeStartCallResult(f.bytes!);
    }
    // field 3 (varint, observed value 4608) is unclear — ignored.
  }
  if (!result) throw new Error('StartCall response missing field 1 (StartCallResult)');
  return result;
}

function decodeStartCallResult(bytes: Uint8Array): StartCallResult {
  const out: StartCallResult = {
    callId: 0n, jwt: '', roomUuid: '', baseUrl: '',
    startedAtMs: 0n, serverAuthTs: 0n,
    peer: { type: PeerType.UNKNOWN, id: 0n }, state: 0,
  };
  for (const f of new Reader(bytes).fields()) {
    switch (f.fieldNumber) {
      case 1: if (f.wireType === 0) out.callId = toSignedInt64(f.varint!); break;
      case 2: if (f.wireType === 2) out.jwt = decodeString(f.bytes!); break;
      case 3: if (f.wireType === 2) out.roomUuid = decodeString(f.bytes!); break;
      case 4: if (f.wireType === 2) {
        for (const inner of new Reader(f.bytes!).fields()) {
          if (inner.fieldNumber === 1 && inner.wireType === 2) {
            out.baseUrl = decodeString(inner.bytes!);
          }
        }
      } break;
      case 6: if (f.wireType === 0) out.startedAtMs = toSignedInt64(f.varint!); break;
      case 8: if (f.wireType === 0) out.serverAuthTs = toSignedInt64(f.varint!); break;
      case 9: if (f.wireType === 2) out.peer = decodePeer(f.bytes!); break;
      case 10: if (f.wireType === 0) out.state = Number(f.varint); break;
    }
  }
  return out;
}

export interface DiscardCallRequest {
  callId: bigint;
  reason?: number;  // observed value 3 (ended/hangup)
}

export function encodeDiscardCall(req: DiscardCallRequest): Uint8Array {
  const w = new Writer();
  w.int(1, req.callId);
  w.int(3, req.reason ?? 3);
  return w.toBytes();
}

export interface DiscardCallResponse {
  // Shape not yet captured; server probably returns empty / status.
}

export function decodeDiscardCallResponse(_bytes: Uint8Array): DiscardCallResponse {
  return {};
}

// ---------------- Meet.ReceiveCall ----------------
// Callee tells Bale "I'm awake and ringing". Takes just {f1: call_id}. Response
// content not closely inspected — we ignore it beyond status.

export interface ReceiveCallRequest { callId: bigint; }

export function encodeReceiveCall(req: ReceiveCallRequest): Uint8Array {
  const w = new Writer();
  w.int(1, req.callId);
  return w.toBytes();
}

export interface ReceiveCallResponse {}
export function decodeReceiveCallResponse(_b: Uint8Array): ReceiveCallResponse { return {}; }

// ---------------- Meet.GetWssURL ----------------
// Returns just `{base_url}` — no JWT. Use AcceptCall (callee) / StartCall (caller)
// to get the JWT. Useful for probing the SFU URL early.

export interface GetWssURLRequest { callId: bigint; }

export function encodeGetWssURL(req: GetWssURLRequest): Uint8Array {
  const w = new Writer();
  w.int(1, req.callId);
  return w.toBytes();
}

export interface GetWssURLResponse { baseUrl: string; }

export function decodeGetWssURLResponse(bytes: Uint8Array): GetWssURLResponse {
  const out: GetWssURLResponse = { baseUrl: '' };
  for (const f of new Reader(bytes).fields()) {
    if (f.fieldNumber === 1 && f.wireType === 2) {
      for (const inner of new Reader(f.bytes!).fields()) {
        if (inner.fieldNumber === 1 && inner.wireType === 2) out.baseUrl = decodeString(inner.bytes!);
      }
    }
  }
  return out;
}

// ---------------- Meet.AcceptCall ----------------
// Callee's accept. Returns the same `StartCallResult` shape as StartCall:
// `{call_id, jwt, room_uuid, base_url, …}`.

export interface AcceptCallRequest {
  callId: bigint;
  mediaFlag?: number;  // inner field 1; observed as 1
}

export function encodeAcceptCall(req: AcceptCallRequest): Uint8Array {
  const w = new Writer();
  w.int(1, req.callId);
  w.message(2, (m) => m.int(1, req.mediaFlag ?? 1));
  return w.toBytes();
}

/** Response is the same wire format as StartCall — reuse the decoder. */
export { decodeStartCallResponse as decodeAcceptCallResponse };

/**
 * Tag identifier for server-pushed "incoming call" notifications on the Bale
 * WebSocket. The push frame has outer envelope structure:
 *   field 2 (wrapper) → field 1 (event-bag) → field [INCOMING_CALL_PUSH_TAG]
 *   (msg) → { f1: call_id, f3: room_uuid, f4.f1: base_url, … }
 * Tag value 52807 (wire 2) = raw bytes 0xba 0xe4 0x19. Observed on web.bale.ai
 * 2026-04-22.
 */
export const INCOMING_CALL_PUSH_TAG_BYTES = new Uint8Array([0xba, 0xe4, 0x19]);

/**
 * Build a URL bundle from a StartCallResult that carries the SFU base URL plus
 * the access token in query params. `connectLivekitRoom()` consumes this and
 * passes the base URL + token separately to the LiveKit SDK.
 *
 * Important: LiveKit SDKs append `/rtc` / `/rtc/v1` internally. Bale's
 * `baseUrl` is already the server root, so we must NOT append `/rtc` here.
 *
 * Bale Meet tokens observed on 2026-05-18 set `video.canPublishData=false`
 * for both StartCall and AcceptCall participants. LiveKit media still connects;
 * the tunnel code falls back to a media-backed carrier when the normal
 * DataPacket path is disabled.
 */
export function buildLiveKitUrl(result: StartCallResult): string {
  const q = new URLSearchParams({
    access_token: result.jwt,
    auto_subscribe: '1',
    sdk: 'js',
    version: '2.15.2',
    protocol: '16',
    adaptive_stream: '0',
  });
  return `${result.baseUrl}?${q.toString()}`;
}

// ---------------- ValidatePassword ----------------

export interface ValidatePasswordRequest {
  password: string; // alias TBD; aiobale's ValidatePassword method class — confirmed below via same pattern
  transactionHash: string;
}

// Field numbers are from aiobale/methods/auth/validate_password.py: code=1, password=2.
// Actually: looking at ValidateCode, field 1=tx, 2=code. ValidatePassword follows the
// same structure with password as field 2.
export function encodeValidatePassword(req: ValidatePasswordRequest): Uint8Array {
  const w = new Writer();
  w.string(1, req.transactionHash);
  w.string(2, req.password);
  const opts = { 1: 1 };
  for (const [k, v] of Object.entries(opts)) {
    w.message(3, (m) => {
      m.int(1, Number(k));
      m.int(2, v);
    });
  }
  return w.toBytes();
}
