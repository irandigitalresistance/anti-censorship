import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  APP_VERSION,
  BaleClient,
  BalePeerType,
  PSK_SALT_INFO,
  NativeBaleSidecar,
  buildMeetOffer,
  decodeClientConfig,
  deriveKeyFromPassword,
  deriveRoomName,
  makeBaleMeetFactory,
  makeLivekitTransport,
  serverFingerprint,
  type TunnelMuxV2,
  type V2LogReport,
  type WebTunnelClientConfigV1,
  type BaleSession,
  type ISidecar as ISidecarLike,
  type LivekitRoomFactory,
  type Peer,
  type Transport,
} from '@webtunnel/shared';
import { runClientTunnelV2, startSocks5Listener, type RunClientTunnelV2Result } from '@webtunnel/client';

export type Carrier = 'webrtc';

export interface TunnelStartOptions {
  /** Carrier for tunnel frames. Defaults to 'webrtc'. */
  carrier?: Carrier;
  /** The Bale peer used to signal which LiveKit call to join. */
  peer?: Peer;
  password?: string;
  socksPort?: number;
  serverLabel?: string;
}

export type LoginStage =
  | 'unauthenticated'
  | 'awaiting-code'
  | 'awaiting-password'
  | 'ready';

export interface ControllerStatus {
  loginStage: LoginStage;
  pendingPhone: string | null;
  me: { id: number; name: string | null; phone: string | null } | null;
  configClient: {
    id: string;
    serverUuid: string;
    serverPeer: Peer;
  } | null;
  tunnel: null | {
    carrier: Carrier;
    peer: Peer;
    serverLabel: string | null;
    socksPort: number;
    startedAt: number;
    bytesUp: number;
    bytesDown: number;
    streamsOpened: number;
    streamsActive: number;
  };
  /** Non-null while a tunnel start is in progress — shows which step we're on. */
  connecting: null | { events: string[] };
  /**
   * `idle` = no retry happening; `retrying` = startup retries before first
   * connect; `reconnecting` = tunnel was up and dropped, we're trying to
   * restore; `failed` = gave up. Cancel by calling stopTunnel().
   */
  retryState: 'idle' | 'retrying' | 'reconnecting' | 'failed';
  retryAttempt: number;
  lastTerminateReason: string | null;
  /** 'mismatch' means the server key changed (suspicious); 'trusted' otherwise. */
  keyTrustState: 'idle' | 'trusted' | 'mismatch';
  sendLogsState: 'idle' | 'sending' | 'sent' | 'queued' | 'failed';
  lastError: string | null;
}

export interface ControllerOptions {
  sessionFile?: string;
  logFilePath?: string;
  /**
   * Factory that produces a connected LivekitRoomLike. Required if the user
   * selects the 'webrtc' carrier. In tests this is typically an in-memory
   * MockLivekitBus-backed factory; in production it wraps `livekit-client`
   * or `@livekit/rtc-node` (see server/src/transports/livekit-rtc-node.ts).
   */
  livekitFactory?: LivekitRoomFactory;
}

function defaultSessionFile(): string {
  const dir = path.join(os.homedir(), '.webtunnel');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'native-session.json');
}

function scheduleMeetOfferRepeats(sidecar: ISidecarLike, peer: Peer, callId: bigint): void {
  const payload = buildMeetOffer(callId);
  const attempts = 5;
  const delayMs = 750;
  void (async () => {
    for (let i = 0; i < attempts; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        await sidecar.sendMessage(peer, payload);
      } catch {
        return;
      }
    }
  })();
}

const V2_HANDSHAKE_TIMEOUT_MS = 12_000;

export class Controller extends EventEmitter {
  private readonly sessionFile: string;
  private readonly configFile: string;
  private readonly keyPinsFile: string;
  private readonly logFilePath: string | null;
  private readonly client: BaleClient;
  private readonly livekitFactory: LivekitRoomFactory | null;
  private sidecar: NativeBaleSidecar | null = null;
  private managedConfig: WebTunnelClientConfigV1 | null = null;
  private mux: TunnelMuxV2 | null = null;
  private socksServer: net.Server | null = null;
  private lastStartOpts: TunnelStartOptions | null = null;
  /** True while a user-initiated cancel is in flight; suppresses reconnect. */
  private userCancelled = false;
  /** Active reconnect timer (null when not reconnecting). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pinnedFingerprints = new Map<string, string>();
  private pendingTransactionHash: string | null = null;
  private currentTransport: Transport | null = null;
  private connectingEvents: string[] = [];
  private status: ControllerStatus = {
    loginStage: 'unauthenticated',
    pendingPhone: null,
    me: null,
    configClient: null,
    tunnel: null,
    connecting: null,
    retryState: 'idle',
    retryAttempt: 0,
    lastTerminateReason: null,
    keyTrustState: 'idle',
    sendLogsState: 'idle',
    lastError: null,
  };

  constructor(opts: ControllerOptions = {}) {
    super();
    this.sessionFile = opts.sessionFile ?? defaultSessionFile();
    this.configFile = path.join(path.dirname(this.sessionFile), 'client-config.json');
    this.keyPinsFile = path.join(path.dirname(this.sessionFile), 'server-key-pins.json');
    this.logFilePath = opts.logFilePath ?? null;
    this.client = new BaleClient();
    this.livekitFactory = opts.livekitFactory ?? null;
    this.loadPinnedFingerprints();
  }

  /**
   * Whether the 'webrtc' carrier is available on this runtime.
   *
   * Available whenever the user is logged into Bale: WebRTC rides Bale's own
   * Meet SFU (`wss://meet-*.ble.ir`) via `BaleClient.startCall`. No env vars
   * needed. Returns `false` only before login is complete (controller has
   * no `BaleSession` yet) OR if an explicit override livekitFactory was
   * supplied (dev mode).
   */
  hasWebrtc(): boolean {
    if (this.livekitFactory) return true;
    return this.client.currentSession() !== null;
  }

  /**
   * Demo-mode bootstrap: skip Bale OTP, plug in a provided sidecar + identity,
   * and optionally override the chat-list resolver. Used by the single-exe
   * demo build so the user can click Start without a real Bale account.
   */
  useDemoSession(opts: {
    me: { id: number; name: string | null; phone: string | null };
    sidecar: NativeBaleSidecar | ISidecarLike;
    listChats?: () => Promise<ReadonlyArray<{ chat_id: number; chat_type: string; title: string; username: string | null; unread: number; last_message: string | null }>>;
  }): void {
    // We cast to NativeBaleSidecar because the controller's private field
    // has that type. In demo mode we supply a mock that satisfies ISidecar;
    // only the fields the tunnel actually touches (sendMessage / onMessage /
    // onClose) matter, all of which both NativeBaleSidecar and MockSidecar
    // implement identically.
    this.sidecar = opts.sidecar as unknown as NativeBaleSidecar;
    if (opts.listChats) {
      this.demoListChats = opts.listChats;
    }
    this.status.me = opts.me;
    this.status.configClient = null;
    this.status.loginStage = 'ready';
    this.status.lastError = null;
    this.pendingTransactionHash = null;
    this.emitStatus();
  }

  private demoListChats: (() => Promise<ReadonlyArray<{ chat_id: number; chat_type: string; title: string; username: string | null; unread: number; last_message: string | null }>>) | null = null;

  init(): void {
    if (fs.existsSync(this.configFile)) {
      void this.loadSavedClientConfig()
        .catch((e) => {
          this.status.lastError = `failed to load saved client config: ${(e as Error).message}`;
          this.emitStatus();
        });
      this.emitStatus();
      return;
    }
    this.emitStatus();
  }

  getStatus(): ControllerStatus {
    return structuredClone(this.status);
  }

  async importClientConfig(rawConfig: string): Promise<void> {
    const payload = await decodeClientConfig(rawConfig);
    this.applyClientConfig(payload);
    fs.writeFileSync(this.configFile, JSON.stringify({ config: rawConfig }, null, 2));
    this.emitStatus();
  }

  private async loadSavedClientConfig(): Promise<void> {
    const raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8')) as { config?: string };
    if (!raw.config) throw new Error('saved config missing config string');
    const payload = await decodeClientConfig(raw.config);
    this.applyClientConfig(payload);
    this.emitStatus();
  }

  private applyClientConfig(payload: WebTunnelClientConfigV1): void {
    this.managedConfig = payload;
    const session: BaleSession = {
      jwt: payload.baleSession.jwt,
      userId: BigInt(payload.baleSession.userId),
      userName: payload.baleSession.userName,
      userAccessHash: BigInt(payload.baleSession.userAccessHash),
    };
    this.client.loadSession(session);
    this.sidecar = new NativeBaleSidecar({ client: this.client });
    this.status.loginStage = 'ready';
    this.status.pendingPhone = null;
    this.status.me = {
      id: Number(session.userId),
      name: null,
      phone: null,
    };
    this.status.configClient = {
      id: payload.clientId,
      serverUuid: payload.serverUuid,
      serverPeer: {
        chatId: payload.serverPeer.chatId,
        chatType: payload.serverPeer.chatType,
      },
    };
    this.status.lastError = null;
    this.pendingTransactionHash = null;
  }

  async sendPhoneCode(phone: string): Promise<void> {
    console.log('[controller] sendPhoneCode');
    this.status.lastError = null;
    try {
      const resp = await this.client.startPhoneAuth(phone);
      console.log(`[controller] startPhoneAuth OK isRegistered=${resp.isRegistered}`);
      this.pendingTransactionHash = resp.transactionHash;
      this.status.pendingPhone = phone;
      this.status.loginStage = 'awaiting-code';
      this.emitStatus();
    } catch (e) {
      console.error('[controller] sendPhoneCode failed:', e);
      this.status.lastError = `send code failed: ${(e as Error).message}\n${(e as Error).stack ?? ''}`;
      this.emitStatus();
      throw e;
    }
  }

  /**
   * Resend the OTP for the currently-pending phone number. Used by the UI
   * "resend code" link on the OTP screen.
   */
  async resendCode(): Promise<void> {
    if (!this.status.pendingPhone) throw new Error('no pending phone to resend');
    await this.sendPhoneCode(this.status.pendingPhone);
  }

  /**
   * Navigate back a step: from the OTP or 2FA screen to the phone-entry screen.
   * Clears the in-flight transaction so the next send-code starts fresh.
   */
  backToPhone(): void {
    this.pendingTransactionHash = null;
    this.status.loginStage = 'unauthenticated';
    this.status.lastError = null;
    this.emitStatus();
  }

  /** From the 2FA screen, go back to the OTP screen. */
  backToCode(): void {
    if (this.status.loginStage !== 'awaiting-password') return;
    this.status.loginStage = 'awaiting-code';
    this.status.lastError = null;
    this.emitStatus();
  }

  async verifyCode(code: string): Promise<void> {
    this.status.lastError = null;
    if (!this.pendingTransactionHash) {
      this.status.lastError = 'no pending login transaction';
      this.emitStatus();
      throw new Error(this.status.lastError);
    }
    try {
      const result = await this.client.validateCode(code, this.pendingTransactionHash);
      if (result === 'PASSWORD_NEEDED') {
        this.status.loginStage = 'awaiting-password';
        this.emitStatus();
        return;
      }
      if (result === 'WRONG_CODE') {
        this.status.lastError = 'wrong code';
        this.emitStatus();
        return;
      }
      if (result === 'SIGN_UP_NEEDED') {
        this.status.lastError = 'account not registered on Bale yet; sign up in the official app first';
        this.emitStatus();
        return;
      }
      if (typeof result === 'string') {
        this.status.lastError = `validate failed: ${result}`;
        this.emitStatus();
        return;
      }
      this.persistSession(result);
      this.onAuthenticated(result);
    } catch (e) {
      this.status.lastError = `verify code failed: ${(e as Error).message}`;
      this.emitStatus();
      throw e;
    }
  }

  async verifyPassword(password: string): Promise<void> {
    this.status.lastError = null;
    if (!this.pendingTransactionHash) {
      this.status.lastError = 'no pending login transaction';
      this.emitStatus();
      throw new Error(this.status.lastError);
    }
    try {
      const result = await this.client.validatePassword(password, this.pendingTransactionHash);
      if (result === 'WRONG_PASSWORD') {
        this.status.lastError = 'wrong 2FA password';
        this.emitStatus();
        return;
      }
      if (typeof result === 'string') {
        this.status.lastError = `validate failed: ${result}`;
        this.emitStatus();
        return;
      }
      this.persistSession(result);
      this.onAuthenticated(result);
    } catch (e) {
      this.status.lastError = `verify password failed: ${(e as Error).message}`;
      this.emitStatus();
      throw e;
    }
  }

  async signOut(): Promise<void> {
    await this.stopTunnel();
    if (this.sidecar) {
      await this.sidecar.close();
      this.sidecar = null;
    }
    if (fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile);
    if (fs.existsSync(this.configFile)) fs.unlinkSync(this.configFile);
    this.managedConfig = null;
    this.status = {
      loginStage: 'unauthenticated',
      pendingPhone: null,
      me: null,
      configClient: null,
      tunnel: null,
      connecting: null,
      retryState: 'idle',
      retryAttempt: 0,
      lastTerminateReason: null,
      keyTrustState: 'idle',
      sendLogsState: 'idle',
      lastError: null,
    };
    this.pendingTransactionHash = null;
    this.emitStatus();
  }

  async listChats(limit = 40): Promise<Array<{ chat_id: number; chat_type: string; title: string; username: string | null; unread: number; last_message: string | null }>> {
    console.log(`[controller] listChats limit=${limit}`);
    if (this.managedConfig) {
      return [{
        chat_id: this.managedConfig.serverPeer.chatId,
        chat_type: this.managedConfig.serverPeer.chatType,
        title: this.managedConfig.serverUuid,
        username: null,
        unread: 0,
        last_message: null,
      }];
    }
    if (this.demoListChats) {
      return [...(await this.demoListChats())];
    }
    if (!this.client.currentSession()) throw new Error('not authenticated');
    const dialogs = await this.client.loadDialogs(limit);
    const privatePeerIds = dialogs.filter((d) => d.peer.type === 1).map((d) => d.peer.id);
    let nameById = new Map<string, { name: string; username?: string }>();
    if (privatePeerIds.length > 0) {
      try {
        const users = await this.client.loadUsers(privatePeerIds.map((id) => ({ id })));
        nameById = new Map(users.map((u) => [String(u.id), { name: u.name, username: u.username }]));
      } catch (e) {
        // Non-fatal: fall back to raw peer IDs.
        // eslint-disable-next-line no-console
        console.warn('[controller] loadUsers failed:', (e as Error).message);
      }
    }
    return dialogs.map((d) => {
      const info = nameById.get(String(d.peer.id));
      const title = info?.name
        || (d.peer.type === 1 ? `user ${d.peer.id}` : `group ${d.peer.id}`);
      return {
        chat_id: Number(d.peer.id),
        chat_type: d.peer.type === 1 ? 'PRIVATE' : 'GROUP',
        title,
        username: info?.username ?? null,
        unread: Number(d.unreadCount),
        last_message: d.content.text ?? null,
      };
    });
  }

  async startTunnel(startOpts: TunnelStartOptions): Promise<{ socksPort: number }> {
    if (!this.sidecar) throw new Error('not authenticated');
    if (this.status.tunnel) throw new Error('tunnel already running');
    if (startOpts.carrier && startOpts.carrier !== 'webrtc') {
      throw new Error(`unsupported Windows carrier: ${String(startOpts.carrier)}`);
    }

    const config = this.managedConfig;
    if (!config) throw new Error('import a client config first');
    const normalized: TunnelStartOptions = {
      carrier: startOpts.carrier ?? 'webrtc',
      peer: { chatId: config.serverPeer.chatId, chatType: config.serverPeer.chatType },
      socksPort: startOpts.socksPort,
      serverLabel: config.serverUuid,
      password: startOpts.password,
    };
    this.lastStartOpts = normalized;
    this.userCancelled = false;
    this.connectingEvents = [];
    this.status.connecting = { events: [] };
    this.status.lastError = null;
    this.status.retryState = 'idle';
    this.status.retryAttempt = 0;
    this.status.lastTerminateReason = null;
    this.emitStatus();

    const maxAttempts = 3;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.status.retryAttempt = attempt;
      this.status.retryState = attempt === 1 ? 'idle' : 'retrying';
      this.emitStatus();
      try {
        const result = await this.startTunnelOnce(normalized);
        this.status.retryState = 'idle';
        this.status.retryAttempt = 0;
        this.status.connecting = null;
        this.emitStatus();
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        lastError = err;
        await this.stopTunnel().catch(() => undefined);
        if (!this.isRetryableStartError(err) || attempt >= maxAttempts) break;
        const delayMs = Math.min(4_000, 300 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
        this.pushConnectingEvent(`Retrying (attempt ${attempt + 1})...`);
        await sleep(delayMs);
      }
    }
    this.status.retryState = 'failed';
    this.status.connecting = null;
    this.status.lastError = lastError?.message ?? 'start tunnel failed';
    this.emitStatus();
    throw lastError ?? new Error('start tunnel failed');
  }

  resetPinnedKey(keyId: string | null = null): void {
    if (keyId == null) {
      this.pinnedFingerprints.clear();
    } else {
      this.pinnedFingerprints.delete(keyId);
    }
    this.savePinnedFingerprints();
    this.status.keyTrustState = 'idle';
    this.emitStatus();
  }

  async sendLogs(): Promise<void> {
    const report = this.buildLogReport();
    this.status.sendLogsState = 'sending';
    this.status.lastError = null;
    this.emitStatus();
    try {
      if (this.mux) {
        this.mux.sendLogReport(report);
        this.status.sendLogsState = 'sent';
      } else if (this.lastStartOpts) {
        // Try a short-lived tunnel just for the upload. If THAT fails, queue
        // for later so the user is never blocked on send-logs working.
        try {
          await this.sendLogsViaShortConnection(this.lastStartOpts, report);
          this.status.sendLogsState = 'sent';
        } catch (e) {
          this.queuePendingLog(report);
          this.status.sendLogsState = 'queued';
          this.status.lastError = `send queued (will retry on next tunnel): ${(e as Error).message}`;
        }
      } else {
        // No tunnel target known yet — queue to disk; will drain on next start.
        this.queuePendingLog(report);
        this.status.sendLogsState = 'queued';
      }
      this.emitStatus();
    } catch (e) {
      // Last-resort: still queue so the user sees "queued" rather than a hard
      // failure.
      try { this.queuePendingLog(report); } catch { /* ignore */ }
      this.status.sendLogsState = 'failed';
      this.status.lastError = `send logs failed: ${(e as Error).message}`;
      this.emitStatus();
      throw e;
    }
  }

  private get pendingLogsDir(): string {
    const dir = path.join(os.homedir(), '.webtunnel', 'pending-logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private queuePendingLog(report: V2LogReport): void {
    const file = path.join(this.pendingLogsDir, `${report.reportId}.json`);
    fs.writeFileSync(file, JSON.stringify(report));
    this.pruneOldPendingLogs();
  }

  /** Total client-side log bytes ≤ 5 MB (per plan). Drop oldest first. */
  private pruneOldPendingLogs(): void {
    const dir = this.pendingLogsDir;
    const files = fs.readdirSync(dir)
      .map((f) => ({ f, full: path.join(dir, f), stat: fs.statSync(path.join(dir, f)) }))
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let total = files.reduce((acc, e) => acc + e.stat.size, 0);
    const cap = 1_500_000; // 1.5 MB cap on pending — main log file uses the other ~3.5 MB.
    while (total > cap && files.length > 0) {
      const oldest = files.shift()!;
      try { fs.unlinkSync(oldest.full); total -= oldest.stat.size; } catch { /* ignore */ }
    }
  }

  /** Called after a successful tunnel start to flush the queue. */
  private async drainPendingLogs(): Promise<void> {
    if (!this.mux) return;
    const dir = this.pendingLogsDir;
    let files: string[];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const report = JSON.parse(raw) as V2LogReport;
        this.mux.sendLogReport(report);
        fs.unlinkSync(full);
      } catch (e) {
        console.warn(`[controller] drainPendingLogs: ${f}: ${(e as Error).message}`);
      }
    }
  }

  private async startTunnelOnce(startOpts: TunnelStartOptions): Promise<{ socksPort: number }> {
    if (!this.sidecar) throw new Error('not authenticated');
    const carrier: Carrier = 'webrtc';
    const { transport, effectivePeer } = await this.createTransport(carrier, startOpts);
    this.currentTransport = transport;
    const keyId = this.serverKeyId(effectivePeer);
    this.pushConnectingEvent('Transport ready, starting handshake...');

    let tunnelResult: RunClientTunnelV2Result;
    try {
      tunnelResult = await withTimeout(
        runClientTunnelV2(transport, {
          metadata: this.clientMetadata(),
          onServerIdentity: ({ publicKey, fingerprint }) => {
            this.assertServerIdentityTrusted(keyId, publicKey, fingerprint);
          },
        }),
        V2_HANDSHAKE_TIMEOUT_MS,
        () => {
          try { transport.close('v2 handshake timeout'); } catch { /* ignore */ }
        },
        `v2 handshake timeout after ${V2_HANDSHAKE_TIMEOUT_MS}ms — server did not respond in time`,
      );
    } catch (e) {
      try { transport.close('start failed'); } catch { /* ignore */ }
      this.currentTransport = null;
      throw e;
    }
    this.pushConnectingEvent('Handshake complete, starting SOCKS5...');
    this.status.keyTrustState = 'trusted';
    const mux = tunnelResult.mux;
    this.mux = mux;
    let muxClosedDuringStart: string | null = null;
    let tunnelMarkedReady = false;

    mux.onTerminate((reason) => {
      this.status.lastTerminateReason = reason;
      this.status.lastError = `server terminated connection: ${reason}`;
      this.emitStatus();
      if (!tunnelMarkedReady) muxClosedDuringStart = `terminated: ${reason}`;
      // Server-initiated terminate is intentional; do not reconnect.
      this.userCancelled = true;
      void this.stopTunnel();
    });
    mux.onClose((reason: string) => {
      if (!tunnelMarkedReady) muxClosedDuringStart = reason;
      if (reason !== 'user stop') {
        this.status.lastError = `tunnel closed: ${reason}`;
        this.emitStatus();
      }
      // If the tunnel was up and the close wasn't user-initiated, schedule a
      // reconnect. Otherwise, just stop.
      if (tunnelMarkedReady && reason !== 'user stop' && !this.userCancelled) {
        void this.handleUnexpectedDrop(reason);
      } else {
        void this.stopTunnel();
      }
    });

    const socksPort = startOpts.socksPort ?? 1080;
    if (muxClosedDuringStart) {
      throw new Error(`MUX_CLOSED_DURING_START:${muxClosedDuringStart}`);
    }
    await assertTcpPortAvailable('127.0.0.1', socksPort);
    const counter = { up: 0, down: 0, streamsOpened: 0, streamsActive: 0 };
    this.socksServer = startSocks5Listener({
      host: '127.0.0.1',
      port: socksPort,
      mux,
      onConnect: () => {
        counter.streamsOpened += 1;
        counter.streamsActive += 1;
        this.pushMetrics(counter);
      },
      onError: (e: Error) => {
        this.status.lastError = `socks5 error: ${e.message}`;
        this.emitStatus();
        if (e.message.includes('mux closed')) {
          void this.stopTunnel();
        }
      },
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.socksServer!;
      const onListening = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        server.off('listening', onListening);
        server.off('error', onError);
      };
      if (server.listening) {
        cleanup();
        resolve();
        return;
      }
      server.once('listening', onListening);
      server.once('error', onError);
    });
    if (muxClosedDuringStart) {
      throw new Error(`MUX_CLOSED_DURING_START:${muxClosedDuringStart}`);
    }
    tunnelMarkedReady = true;

    // Drain any logs the user queued while disconnected.
    void this.drainPendingLogs();

    this.status.tunnel = {
      carrier,
      peer: effectivePeer,
      serverLabel: startOpts.serverLabel ?? null,
      socksPort,
      startedAt: Date.now(),
      bytesUp: 0,
      bytesDown: 0,
      streamsOpened: 0,
      streamsActive: 0,
    };
    this.status.lastError = null;
    this.emitStatus();
    return { socksPort };
  }

  private async createTransport(
    carrier: Carrier,
    startOpts: TunnelStartOptions,
  ): Promise<{ transport: Transport; effectivePeer: Peer }> {
    if (!this.sidecar) throw new Error('not authenticated');
    if (!startOpts.peer) throw new Error('a Bale peer must be selected');
    const effectivePeer = startOpts.peer;
    if (carrier !== 'webrtc') throw new Error(`unknown carrier: ${String(carrier)}`);
    this.pushConnectingEvent('Initiating Bale Meet call...');
    const capturedSidecar = this.sidecar;
    const capturedPeer = effectivePeer;
    const usingInjectedFactory = this.livekitFactory != null;
    const factory: LivekitRoomFactory = this.livekitFactory ?? makeBaleMeetFactory({
      client: this.client,
      targetPeer: {
        type: effectivePeer.chatType === 'PRIVATE' || effectivePeer.chatType === 'BOT'
          ? BalePeerType.PRIVATE : BalePeerType.GROUP,
        id: BigInt(effectivePeer.chatId),
      },
      onCallerStarted: async (result) => {
        if (!capturedSidecar) return;
        try {
          await capturedSidecar.sendMessage(capturedPeer, buildMeetOffer(result.callId));
          scheduleMeetOfferRepeats(capturedSidecar, capturedPeer, result.callId);
        } catch {
          // best-effort signalling
        }
      },
    });
    const roomSeed = startOpts.password && startOpts.password.length > 0
      ? deriveKeyFromPassword(startOpts.password, new TextEncoder().encode(PSK_SALT_INFO))
      : new TextEncoder().encode(`${effectivePeer.chatType}:${effectivePeer.chatId}`);
    const roomName = await deriveRoomName(roomSeed, 'wt2-room');
    const room = await factory({
      side: 'client',
      roomName,
      identity: 'client',
      peerIdentity: 'server',
    });
    const transport = makeLivekitTransport(usingInjectedFactory
      ? { room, peerIdentity: 'server' }
      : { room });
    return { transport, effectivePeer };
  }

  private isRetryableStartError(error: Error): boolean {
    if (error.message.includes('SERVER_KEY_MISMATCH')) return false;
    if (error.message.includes('SOCKS_PORT_IN_USE')) return false;
    if (error.message.includes('SOCKS_PORT_UNAVAILABLE')) return false;
    if (error.message.includes('CONFIG_ALREADY_CONNECTED')) return false;
    if (error.message.includes('CONFIG_REQUIRED')) return false;
    if (error.message.includes('CONFIG_UNKNOWN_CLIENT')) return false;
    if (error.message.includes('BALE_LIVEKIT_DATA_DISABLED')) return false;
    return true;
  }

  private pushConnectingEvent(event: string): void {
    const stamped = `[${new Date().toLocaleTimeString()}] ${event}`;
    console.log(`[controller] connecting: ${event}`);
    this.connectingEvents.push(stamped);
    this.status.connecting = { events: [...this.connectingEvents] };
    this.emitStatus();
  }

  async speedTest(): Promise<{ latencyMs: number; uploadKbps: number; downloadKbps: number }> {
    const mux = this.mux;
    if (!mux) throw new Error('no active tunnel');

    // Latency: average of 3 pings
    let totalRtt = 0;
    const pings = 3;
    for (let i = 0; i < pings; i++) {
      totalRtt += await mux.measurePingRtt(5_000);
      if (i < pings - 1) await sleep(200);
    }
    const latencyMs = Math.round(totalRtt / pings);

    // Download via speedtest stream. Upload is intentionally not measured here:
    // transport writes are queued, so a local write loop measures enqueue speed
    // rather than real media-carrier throughput.
    const stream = mux.openStream({ kind: 'domain', host: 'wt-speedtest', port: 0 });
    let downloadBytes = 0;

    const downloadDone = new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('speedtest timeout')), 20_000);
      stream.onData((data) => {
        downloadBytes += data.byteLength;
      });
      stream.onClose(() => {
        clearTimeout(t);
        resolve(downloadBytes);
      });
    });

    const downloadStart = Date.now();
    stream.write(new Uint8Array([1, 2, 3, 4]));
    await downloadDone;
    const downloadMs = Date.now() - downloadStart;

    const uploadKbps = -1;
    const downloadKbps = Math.round((downloadBytes / 1024) / (downloadMs / 1000));
    return { latencyMs, uploadKbps, downloadKbps };
  }

  private assertServerIdentityTrusted(
    keyId: string,
    publicKey: Uint8Array,
    fingerprint: string,
  ): void {
    const expected = serverFingerprint(publicKey);
    if (expected !== fingerprint) throw new Error('server fingerprint verification failed (internal error)');
    if (this.managedConfig?.serverFingerprint && this.managedConfig.serverFingerprint !== fingerprint) {
      this.status.keyTrustState = 'mismatch';
      this.status.lastError =
        `SERVER_KEY_MISMATCH: The config was issued for a different server key.\n` +
        `Expected: ${this.managedConfig.serverFingerprint.slice(0, 16)}...\n` +
        `Got:      ${fingerprint.slice(0, 16)}...`;
      this.emitStatus();
      throw new Error('SERVER_KEY_MISMATCH');
    }
    // Carrier-neutral pin scheme: key by `fp:<hex>` of the server's Ed25519
    // public key. Same key is used regardless of which carrier reached the
    // server. Migration: a same-fingerprint match against the
    // legacy `${chatType}:${chatId}` key still validates and is auto-rewritten
    // under the new scheme.
    const fpKey = 'fp:' + fingerprint;
    const pinnedByFp = this.pinnedFingerprints.get(fpKey) ?? null;
    const pinnedByLegacyPeer = this.pinnedFingerprints.get(keyId) ?? null;

    if (!pinnedByFp && !pinnedByLegacyPeer) {
      // First connection: TOFU under the fp-key.
      this.pinnedFingerprints.set(fpKey, fingerprint);
      this.savePinnedFingerprints();
      console.log(`[controller] TOFU: auto-pinned server fp=${fingerprint}`);
      this.pushConnectingEvent('Server key pinned (first connect).');
      this.status.keyTrustState = 'trusted';
      this.emitStatus();
      return;
    }
    if (pinnedByFp && pinnedByFp !== fingerprint) {
      this.status.keyTrustState = 'mismatch';
      this.status.lastError =
        `SERVER_KEY_MISMATCH: The server's identity has changed.\n` +
        `Expected: ${pinnedByFp.slice(0, 16)}...\n` +
        `Got:      ${fingerprint.slice(0, 16)}...\n\n` +
        `If the server was reinstalled this is expected — use "Clear pins" to reset and reconnect.`;
      this.emitStatus();
      throw new Error('SERVER_KEY_MISMATCH');
    }
    if (!pinnedByFp && pinnedByLegacyPeer) {
      // Legacy peer-keyed pin matched. Rewrite under the new fp-key.
      if (pinnedByLegacyPeer !== fingerprint) {
        this.status.keyTrustState = 'mismatch';
        this.status.lastError =
          `SERVER_KEY_MISMATCH: legacy pin for ${keyId} does not match.`;
        this.emitStatus();
        throw new Error('SERVER_KEY_MISMATCH');
      }
      this.pinnedFingerprints.set(fpKey, fingerprint);
      this.savePinnedFingerprints();
      console.log(`[controller] migrated legacy pin ${keyId} → ${fpKey}`);
    }
    this.status.keyTrustState = 'trusted';
  }

  private clientMetadata(): Record<string, string | number> {
    const metadata: Record<string, string | number> = {
      clientType: 'windows',
      clientVersion: APP_VERSION,
    };
    if (this.managedConfig) {
      metadata.webTunnelClientId = this.managedConfig.clientId;
      metadata.webTunnelConfigVersion = 1;
    }
    return metadata;
  }

  private serverKeyId(peer: Peer): string {
    // Retained for legacy-key lookup during migration; new pins use fp keys.
    return `${peer.chatType}:${peer.chatId}`;
  }

  private loadPinnedFingerprints(): void {
    try {
      if (!fs.existsSync(this.keyPinsFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.keyPinsFile, 'utf8')) as Record<string, string>;
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.length > 0) this.pinnedFingerprints.set(key, value);
      }
    } catch {
      this.pinnedFingerprints.clear();
    }
  }

  private savePinnedFingerprints(): void {
    const out: Record<string, string> = {};
    for (const [key, value] of this.pinnedFingerprints) out[key] = value;
    fs.writeFileSync(this.keyPinsFile, JSON.stringify(out, null, 2));
  }

  private buildLogReport(): V2LogReport {
    const text = this.readRecentLogs(180_000);
    return {
      reportId: crypto.randomUUID(),
      source: 'client-electron',
      sentAt: Date.now(),
      fileName: 'client-debug.log',
      contentType: 'text/plain; charset=utf-8',
      body: text,
      meta: {
        platform: process.platform,
        pid: process.pid,
      },
    };
  }

  private readRecentLogs(maxBytes: number): string {
    if (!this.logFilePath) return 'log file path unavailable';
    try {
      const raw = fs.readFileSync(this.logFilePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;
      return raw.slice(Math.max(0, raw.length - maxBytes));
    } catch (e) {
      return `failed to read logs: ${(e as Error).message}`;
    }
  }

  private async sendLogsViaShortConnection(startOpts: TunnelStartOptions, report: V2LogReport): Promise<void> {
    const { transport, effectivePeer } = await this.createTransport('webrtc', startOpts);
    const keyId = this.serverKeyId(effectivePeer);
    const tunnel = await withTimeout(
      runClientTunnelV2(transport, {
        metadata: this.clientMetadata(),
        onServerIdentity: ({ publicKey, fingerprint }) => {
          this.assertServerIdentityTrusted(keyId, publicKey, fingerprint);
        },
      }),
      V2_HANDSHAKE_TIMEOUT_MS,
      () => {
        try { transport.close('log upload handshake timeout'); } catch { /* ignore */ }
      },
      `v2 handshake timeout after ${V2_HANDSHAKE_TIMEOUT_MS}ms`,
    );
    tunnel.mux.sendLogReport(report);
    await sleep(350);
    tunnel.mux.close('log upload done');
    transport.close('log upload done');
  }

  async stopTunnel(): Promise<void> {
    // Mark as user cancel so any in-flight reconnect bails out.
    this.userCancelled = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.mux) {
      this.mux.close('user stop');
      this.mux = null;
    }
    if (this.currentTransport) {
      try { this.currentTransport.close('user stop'); } catch { /* ignore */ }
      this.currentTransport = null;
    }
    if (this.socksServer) {
      const srv = this.socksServer;
      this.socksServer = null;
      await new Promise<void>((r) => {
        try {
          srv.close(() => r());
        } catch {
          r();
        }
      });
    }
    this.status.tunnel = null;
    this.status.connecting = null;
    this.connectingEvents = [];
    this.status.retryState = 'idle';
    this.status.retryAttempt = 0;
    this.emitStatus();
  }

  /**
   * Tunnel was running and dropped unexpectedly. Tear down stale state, then
   * loop reconnect with exponential backoff (capped at 30 s). Loop exits when
   * stopTunnel() is called (sets userCancelled) or a reconnect succeeds.
   */
  private async handleUnexpectedDrop(reason: string): Promise<void> {
    if (!this.lastStartOpts) {
      await this.stopTunnel();
      return;
    }
    // Tear down stale resources but DON'T set userCancelled or reset retryState
    // — we're going to reconnect.
    if (this.mux) { try { this.mux.close('reconnect'); } catch { /* ignore */ } this.mux = null; }
    if (this.currentTransport) { try { this.currentTransport.close('reconnect'); } catch { /* ignore */ } this.currentTransport = null; }
    if (this.socksServer) {
      const srv = this.socksServer;
      this.socksServer = null;
      await new Promise<void>((r) => { try { srv.close(() => r()); } catch { r(); } });
    }
    this.status.tunnel = null;
    this.status.retryState = 'reconnecting';
    this.status.retryAttempt = 0;
    this.connectingEvents = [];
    this.pushConnectingEvent(`Tunnel dropped (${reason}); reconnecting…`);

    let attempt = 0;
    while (!this.userCancelled) {
      attempt += 1;
      this.status.retryAttempt = attempt;
      this.emitStatus();
      const delayMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt - 1, 5))) + Math.floor(Math.random() * 500);
      this.pushConnectingEvent(`Reconnect attempt ${attempt} in ${Math.round(delayMs / 1000)}s…`);
      await new Promise<void>((resolve) => {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          resolve();
        }, delayMs);
      });
      if (this.userCancelled) break;
      try {
        this.pushConnectingEvent(`Reconnecting (attempt ${attempt})…`);
        await this.startTunnelOnce(this.lastStartOpts);
        // Success — startTunnelOnce sets status.tunnel and resets retry state.
        this.status.retryState = 'idle';
        this.status.retryAttempt = 0;
        this.status.connecting = null;
        this.emitStatus();
        return;
      } catch (e) {
        this.status.lastError = `reconnect attempt ${attempt} failed: ${(e as Error).message}`;
        this.emitStatus();
        // loop again
      }
    }
    // Cancelled by user.
    this.status.retryState = 'idle';
    this.status.retryAttempt = 0;
    this.status.connecting = null;
    this.emitStatus();
  }

  async dispose(): Promise<void> {
    await this.stopTunnel();
    if (this.sidecar) {
      await this.sidecar.close();
      this.sidecar = null;
    }
  }

  /**
   * Persist a crash to disk and surface it in status. Crashes ride the same
   * pending-logs queue so they upload on the next successful tunnel.
   */
  async recordCrash(kind: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    const reportId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `crash-${Date.now()}`;
    const body = `[${new Date().toISOString()}] ${kind}: ${message}\n${stack}\n`;
    const report: V2LogReport = {
      reportId,
      source: 'client-electron-crash',
      sentAt: Date.now(),
      fileName: `crash-${kind}-${Date.now()}.txt`,
      contentType: 'text/plain; charset=utf-8',
      body,
      meta: { platform: process.platform, pid: process.pid, kind },
    };
    try { this.queuePendingLog(report); } catch (e) {
      console.warn('[controller] queuePendingLog (crash) failed:', (e as Error).message);
    }
    this.status.lastError = `${kind}: ${message}`;
    this.emitStatus();
    if (this.mux) {
      try { this.mux.sendLogReport(report); } catch { /* best effort */ }
    }
  }

  private persistSession(session: BaleSession): void {
    fs.writeFileSync(
      this.sessionFile,
      JSON.stringify({
        jwt: session.jwt,
        userId: String(session.userId),
        userName: session.userName,
        userAccessHash: String(session.userAccessHash),
      }),
    );
  }

  private onAuthenticated(session: BaleSession): void {
    this.sidecar = new NativeBaleSidecar({ client: this.client });
    this.managedConfig = null;
    this.status.loginStage = 'ready';
    this.status.me = {
      id: Number(session.userId),
      name: session.userName,
      phone: null,
    };
    this.status.configClient = null;
    this.status.lastError = null;
    this.pendingTransactionHash = null;
    this.emitStatus();
  }

  private pushMetrics(counter: { up: number; down: number; streamsOpened: number; streamsActive: number }): void {
    if (!this.status.tunnel) return;
    this.status.tunnel.bytesUp = counter.up;
    this.status.tunnel.bytesDown = counter.down;
    this.status.tunnel.streamsOpened = counter.streamsOpened;
    this.status.tunnel.streamsActive = counter.streamsActive;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout(); } catch { /* ignore */ }
      reject(new Error(message));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function assertTcpPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      fn();
    };
    probe.once('error', (err: NodeJS.ErrnoException) => {
      const marker = err.code === 'EADDRINUSE' ? 'SOCKS_PORT_IN_USE' : 'SOCKS_PORT_UNAVAILABLE';
      const detail = err.code ? ` (${err.code})` : '';
      finish(() => reject(new Error(`${marker}:${host}:${port}${detail}`)));
    });
    probe.listen(port, host, () => {
      probe.close((closeErr) => {
        if (closeErr) {
          finish(() => reject(closeErr));
          return;
        }
        finish(resolve);
      });
    });
  });
}
