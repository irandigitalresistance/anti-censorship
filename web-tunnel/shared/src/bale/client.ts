import {
  ChatType,
  ListLoadMode,
  PeerType,
  buildLiveKitUrl,
  decodeAcceptCallResponse,
  decodeDiscardCallResponse,
  decodeGetWssURLResponse,
  decodeLoadDialogsResponse,
  decodeLoadHistoryResponse,
  decodeLoadUsersResponse,
  decodePhoneAuthResponse,
  decodeReceiveCallResponse,
  decodeSendMessageResponse,
  decodeStartCallResponse,
  decodeValidateCodeResponse,
  encodeAcceptCall,
  encodeDiscardCall,
  encodeGetWssURL,
  encodeLoadDialogs,
  encodeLoadHistory,
  encodeLoadUsers,
  encodeReceiveCall,
  encodeSendMessage,
  encodeStartCall,
  encodeStartPhoneAuth,
  encodeValidateCode,
  encodeValidatePassword,
  type BaleUser,
  type DialogPeerData,
  type GetWssURLResponse,
  type HistoryMessage,
  type InfoPeer,
  type Peer,
  type PhoneAuthResponse,
  type SendMessageRequest,
  type StartCallResult,
  type ValidateCodeResponse,
} from './messages.js';
import { GrpcError, grpcUnary, makeSessionId } from './grpc-web.js';

/** Device constants — same as aiobale's defaults so Bale doesn't see anomalous clients. */
export const DEFAULT_APP_ID = 4;
export const DEFAULT_APP_KEY = 'C28D46DC4C3A7A26564BFCC48B929086A95C93C98E789A19847BEE8627DE4E7D';

export type AuthError =
  | 'WRONG_CODE'
  | 'PASSWORD_NEEDED'
  | 'SIGN_UP_NEEDED'
  | 'WRONG_PASSWORD'
  | 'UNKNOWN';

export interface BaleSession {
  jwt: string;
  userId: bigint;
  userName: string | null;
  userAccessHash: bigint;
}

export interface BaleClientOptions {
  deviceHash?: string;
  deviceTitle?: string;
  /** Starts a persistent session id that gets re-used across calls in this process. */
  sessionId?: string;
}

export class BaleClient {
  private readonly deviceHash: string;
  private readonly deviceTitle: string;
  private readonly sessionId: string;
  private session: BaleSession | null = null;

  constructor(opts: BaleClientOptions = {}) {
    this.deviceHash = opts.deviceHash ?? crypto.randomUUID();
    this.deviceTitle = opts.deviceTitle ?? 'Chrome_143.0.0.0, Windows';
    this.sessionId = opts.sessionId ?? makeSessionId();
  }

  /** Load a previously-persisted session. */
  loadSession(session: BaleSession): void {
    this.session = session;
  }

  currentSession(): BaleSession | null {
    return this.session;
  }

  /** Phone auth step 1: request an OTP. */
  async startPhoneAuth(phoneNumber: string | number | bigint): Promise<PhoneAuthResponse> {
    const phone =
      typeof phoneNumber === 'string'
        ? BigInt(phoneNumber.replace(/[^\d]/g, ''))
        : BigInt(phoneNumber);
    return grpcUnary(
      'bale.auth.v1.Auth',
      'StartPhoneAuth',
      {
        phoneNumber: phone,
        appId: DEFAULT_APP_ID,
        appKey: DEFAULT_APP_KEY,
        deviceHash: this.deviceHash,
        deviceTitle: this.deviceTitle,
        sendCodeType: 0,
      },
      encodeStartPhoneAuth,
      decodePhoneAuthResponse,
      { sessionId: this.sessionId },
    );
  }

  /**
   * Phone auth step 2: validate the OTP. Returns the session on success, or a
   * sentinel AuthError for the known failure modes. Unknown errors throw.
   */
  async validateCode(
    code: string,
    transactionHash: string,
  ): Promise<BaleSession | AuthError> {
    return this.handleValidateResponse(
      grpcUnary(
        'bale.auth.v1.Auth',
        'ValidateCode',
        { code, transactionHash },
        encodeValidateCode,
        decodeValidateCodeResponse,
        { sessionId: this.sessionId },
      ),
    );
  }

  /** Phone auth step 3 (only if `validateCode` returned 'PASSWORD_NEEDED'). */
  async validatePassword(
    password: string,
    transactionHash: string,
  ): Promise<BaleSession | AuthError> {
    return this.handleValidateResponse(
      grpcUnary(
        'bale.auth.v1.Auth',
        'ValidatePassword',
        { password, transactionHash },
        encodeValidatePassword,
        decodeValidateCodeResponse,
        { sessionId: this.sessionId },
      ),
    );
  }

  /** List recent dialogs. Requires an authenticated session. */
  async loadDialogs(limit = 40): Promise<DialogPeerData[]> {
    this.requireAuth();
    const resp = await grpcUnary(
      'bale.messaging.v2.Messaging',
      'LoadDialogs',
      { offsetDate: -1n, limit, excludePinned: false },
      encodeLoadDialogs,
      decodeLoadDialogsResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
    return resp.dialogs;
  }

  /** Send a plain-text message to a peer. Returns a random message id. */
  async sendTextMessage(peer: Peer, chatType: ChatType, text: string): Promise<bigint> {
    this.requireAuth();
    const messageId = randomId64();
    const req: SendMessageRequest = {
      peer,
      messageId,
      content: { text },
      chat: { type: chatType, id: peer.id },
    };
    await grpcUnary(
      'bale.messaging.v2.Messaging',
      'SendMessage',
      req,
      encodeSendMessage,
      decodeSendMessageResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
    return messageId;
  }

  /** Resolve a list of peer IDs to full user objects (including display name). */
  async loadUsers(peers: InfoPeer[]): Promise<BaleUser[]> {
    this.requireAuth();
    if (peers.length === 0) return [];
    const resp = await grpcUnary(
      'bale.users.v1.Users',
      'LoadUsers',
      { peers },
      encodeLoadUsers,
      decodeLoadUsersResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
    return resp.users;
  }

  /**
   * Fetch history for a peer.
   * - `FORWARD` + `offsetDate=T` → messages strictly newer than T (oldest-first).
   * - `BACKWARD` + `offsetDate=0` → the newest N messages (newest-first).
   */
  async loadHistory(
    peer: Peer,
    _chatType: ChatType,
    offsetDate: bigint,
    limit = 40,
    loadMode: ListLoadMode = ListLoadMode.FORWARD,
  ): Promise<HistoryMessage[]> {
    this.requireAuth();
    const resp = await grpcUnary(
      'bale.messaging.v2.Messaging',
      'LoadHistory',
      { peer, date: offsetDate, loadMode, limit },
      encodeLoadHistory,
      decodeLoadHistoryResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
    return resp.messages;
  }

  /**
   * Initiate a voice/video call to `targetPeer`. Returns LiveKit connection
   * creds: `{callId, jwt, roomUuid, baseUrl, ...}`. Use `buildLiveKitUrl()` to
   * assemble the full `wss://.../rtc?access_token=...` URL for the SFU.
   *
   * The call is "live" on Bale until you call `discardCall(callId)` or the
   * other party declines. For tunnel use we hang up from the SAME account that
   * initiated the call.
   */
  async startCall(targetPeer: Peer, mediaFlag = 1): Promise<StartCallResult> {
    this.requireAuth();
    const rid = randomId64();
    return grpcUnary(
      'bale.meet.v1.Meet',
      'StartCall',
      { peer: targetPeer, rid, mediaFlag },
      encodeStartCall,
      decodeStartCallResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
  }

  /**
   * Tear down a Meet call. Reason 3 = normal hangup (observed).
   */
  async discardCall(callId: bigint, reason = 3): Promise<void> {
    this.requireAuth();
    await grpcUnary(
      'bale.meet.v1.Meet',
      'DiscardCall',
      { callId, reason },
      encodeDiscardCall,
      decodeDiscardCallResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
  }

  /**
   * Callee side: tell Bale we received the incoming-call push. Typically fired
   * immediately after an incoming-call event lands on the persistent WS.
   */
  async receiveCall(callId: bigint): Promise<void> {
    this.requireAuth();
    await grpcUnary(
      'bale.meet.v1.Meet',
      'ReceiveCall',
      { callId },
      encodeReceiveCall,
      decodeReceiveCallResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
  }

  /**
   * Probe the LiveKit SFU base URL for a given call (no JWT). Handy if you
   * want to pre-warm a connection before calling AcceptCall.
   */
  async getWssURL(callId: bigint): Promise<GetWssURLResponse> {
    this.requireAuth();
    return grpcUnary(
      'bale.meet.v1.Meet',
      'GetWssURL',
      { callId },
      encodeGetWssURL,
      decodeGetWssURLResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
  }

  /**
   * Callee side: accept an incoming call. Returns `{callId, jwt, roomUuid,
   * baseUrl, …}` — identical shape to StartCall's return, so the callee joins
   * the LiveKit room exactly the same way the caller does.
   */
  async acceptCall(callId: bigint, mediaFlag = 1): Promise<StartCallResult> {
    this.requireAuth();
    return grpcUnary(
      'bale.meet.v1.Meet',
      'AcceptCall',
      { callId, mediaFlag },
      encodeAcceptCall,
      decodeAcceptCallResponse,
      { sessionId: this.sessionId, accessToken: this.session!.jwt },
    );
  }

  /** Construct the LiveKit SFU URL from a StartCall / AcceptCall result. */
  liveKitUrlFor(result: StartCallResult): string {
    return buildLiveKitUrl(result);
  }

  private requireAuth(): void {
    if (!this.session) throw new Error('BaleClient: not authenticated');
  }

  private async handleValidateResponse(
    promise: Promise<ValidateCodeResponse>,
  ): Promise<BaleSession | AuthError> {
    let resp: ValidateCodeResponse;
    try {
      resp = await promise;
    } catch (e) {
      if (e instanceof GrpcError) {
        const msg = e.message.toLowerCase();
        if (msg.includes('phone_code_invalid') || msg.includes('wrong code')) return 'WRONG_CODE';
        if (msg.includes('password needed')) return 'PASSWORD_NEEDED';
        if (msg.includes('phone_number_unoccupied')) return 'SIGN_UP_NEEDED';
        if (msg.includes('wrong password')) return 'WRONG_PASSWORD';
      }
      throw e;
    }
    if (!resp.jwt || !resp.user) return 'UNKNOWN';
    const session: BaleSession = {
      jwt: resp.jwt,
      userId: resp.user.id,
      userName: resp.user.name || null,
      userAccessHash: resp.user.accessHash,
    };
    this.session = session;
    return session;
  }
}

function randomId64(): bigint {
  const a = crypto.getRandomValues(new Uint8Array(8));
  let v = 0n;
  for (const b of a) v = (v << 8n) | BigInt(b);
  // Clamp to signed positive to avoid weird negative rids.
  return v & ((1n << 62n) - 1n);
}

export { ChatType, PeerType };
