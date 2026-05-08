import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  BaleChatType,
  BaleClient,
  BaleIncomingCallWatcher,
  NativeBaleSidecar,
  PSK_SALT_INFO,
  buildLiveKitUrl,
  connectLivekitRoom,
  createV2ServerIdentityFromPrivateKey,
  deriveKeyFromPassword,
  makeLocalLivekitRoomFactory,
  serverFingerprint,
  startLocalLivekitBroker,
  type V2LogReport,
  type V2ServerIdentity,
  type LocalLivekitBrokerHandle,
  type BaleSession,
  type LivekitRoomFactory,
  type StartCallResult,
} from '@webtunnel/shared';
import {
  BaleServerDispatcher,
  ClientLogStore,
  CrashStore,
  TunnelManager,
  startDashboard,
  startWebrtcServer,
  type ClientLogSummary,
  type CrashRecord,
  type DashboardHandles,
  type TunnelPeerSummary,
  type TunnelSnapshot,
  type UserStats,
} from '@webtunnel/server';

export type LoginStage =
  | 'unauthenticated'
  | 'awaiting-code'
  | 'awaiting-password'
  | 'ready';

export interface ServerStatus {
  loginStage: LoginStage;
  pendingPhone: string | null;
  me: { id: number; name: string | null; phone: string | null } | null;
  running: boolean;
  tunnelsActive: number;
  streamsActive: number;
  /** Active-only sum (drops when a tunnel closes — kept for UI compat). */
  bytesUp: number;
  bytesDown: number;
  /** MONOTONIC cumulative bytes since the server started (or last restart). */
  lifetimeBytesUp: number;
  lifetimeBytesDown: number;
  startedAt: number | null;
  connections: ServerConnectionStatus[];
  /** All known users (Bale accounts) with persistent up/down counters. */
  users: ServerUserStats[];
  logs: ClientLogSummary[];
  crashes: CrashRecord[];
  serverFingerprint: string | null;
  lastError: string | null;
  /** URL clients can POST diagnostics to without an active tunnel. */
  uploadEndpoint: string | null;
}

export interface ServerUserStats {
  peerKey: string;
  chatId: number;
  chatType: string;
  name: string | null;
  username: string | null;
  bytesUp: number;
  bytesDown: number;
  totalBytes: number;
  firstSeen: number;
  lastSeen: number;
  /** Number of currently-active tunnels for this user. 0 means idle. */
  activeConnections: number;
  /** Active-tunnel ids belonging to this user. */
  activeTunnelIds: string[];
}

export interface ServerConnectionStreamStatus {
  streamId: number;
  target: string;
  openedAt: number;
  bytesUp: number;
  bytesDown: number;
}

export interface ServerConnectionStatus {
  id: string;
  label: string;
  carrier: string | null;
  protocolVersion: number | null;
  terminable: boolean;
  terminationState: 'idle' | 'terminating' | 'terminated' | 'failed';
  openedAt: number;
  userLabel: string;
  peerLabel: string;
  username: string | null;
  clientType: string | null;
  clientVersion: string | null;
  streamsOpened: number;
  streamsActive: number;
  bytesUp: number;
  bytesDown: number;
  totalBytes: number;
  streams: ServerConnectionStreamStatus[];
}

export interface ServerControllerOptions {
  sessionFile?: string;
}

function defaultSessionFile(): string {
  const dir = path.join(os.homedir(), '.webtunnel');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'server-native-session.json');
}

export class ServerController extends EventEmitter {
  private readonly sessionFile: string;
  private readonly identityFile: string;
  private readonly statsFile: string;
  private readonly userStatsFile: string;
  /**
   * Per-user stats live BOTH on disk (`server-user-stats.json`) and inside
   * the active TunnelManager. When the server is stopped, the manager is
   * gone but the in-memory cache stays so the dashboard keeps showing the
   * users — operator can still hit Reset on them.
   */
  private cachedUserStats: UserStats[] = [];
  private readonly client: BaleClient;
  private sidecar: NativeBaleSidecar | null = null;
  private incomingCalls: BaleIncomingCallWatcher | null = null;
  private dispatcher: BaleServerDispatcher | null = null;
  private manager: TunnelManager | null = null;
  private logStore: ClientLogStore | null = null;
  private crashStore: CrashStore | null = null;
  private dashboardHandles: DashboardHandles | null = null;
  private serverIdentity: V2ServerIdentity | null = null;
  private mockBroker: LocalLivekitBrokerHandle | null = null;
  private webrtcStop: (() => Promise<void>) | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private statsPersistTimer: ReturnType<typeof setInterval> | null = null;
  private pendingTransactionHash: string | null = null;
  private readonly peerLookupCache = new Map<string, { name: string | null; username: string | null }>();
  private readonly pendingPeerLookups = new Set<string>();
  private readonly peerLookupLastAttempt = new Map<string, number>();
  private status: ServerStatus = {
    loginStage: 'unauthenticated',
    pendingPhone: null,
    me: null,
    running: false,
    tunnelsActive: 0,
    streamsActive: 0,
    bytesUp: 0,
    bytesDown: 0,
    lifetimeBytesUp: 0,
    lifetimeBytesDown: 0,
    startedAt: null,
    crashes: [],
    uploadEndpoint: null,
    connections: [],
    users: [],
    logs: [],
    serverFingerprint: null,
    lastError: null,
  };

  constructor(opts: ServerControllerOptions = {}) {
    super();
    this.sessionFile = opts.sessionFile ?? defaultSessionFile();
    this.identityFile = path.join(path.dirname(this.sessionFile), 'server-v2-identity.json');
    this.statsFile = path.join(path.dirname(this.sessionFile), 'server-stats.json');
    this.userStatsFile = path.join(path.dirname(this.sessionFile), 'server-user-stats.json');
    this.client = new BaleClient();
    const persisted = this.loadPersistedStats();
    this.status.lifetimeBytesUp = persisted.up;
    this.status.lifetimeBytesDown = persisted.down;
    this.cachedUserStats = this.loadPersistedUserStats();
    this.status.users = this.cachedUserStats.map(toServerUserStats);
  }

  private loadPersistedStats(): { up: number; down: number } {
    try {
      if (!fs.existsSync(this.statsFile)) return { up: 0, down: 0 };
      const raw = JSON.parse(fs.readFileSync(this.statsFile, 'utf8')) as {
        lifetimeBytesUp?: number;
        lifetimeBytesDown?: number;
      };
      return {
        up: Math.max(0, Math.floor(raw.lifetimeBytesUp ?? 0)),
        down: Math.max(0, Math.floor(raw.lifetimeBytesDown ?? 0)),
      };
    } catch {
      return { up: 0, down: 0 };
    }
  }

  private loadPersistedUserStats(): UserStats[] {
    try {
      if (!fs.existsSync(this.userStatsFile)) return [];
      const raw = JSON.parse(fs.readFileSync(this.userStatsFile, 'utf8')) as { users?: UserStats[] };
      const users = Array.isArray(raw.users) ? raw.users : [];
      return users
        .filter((u) => u && typeof u.peerKey === 'string')
        .map((u) => ({
          peerKey: u.peerKey,
          chatId: u.chatId,
          chatType: u.chatType,
          name: u.name ?? null,
          username: u.username ?? null,
          bytesUp: Math.max(0, Math.floor(u.bytesUp ?? 0)),
          bytesDown: Math.max(0, Math.floor(u.bytesDown ?? 0)),
          firstSeen: u.firstSeen ?? Date.now(),
          lastSeen: u.lastSeen ?? Date.now(),
        }));
    } catch (e) {
      console.warn('[controller] loadPersistedUserStats failed:', (e as Error).message);
      return [];
    }
  }

  private persistStats(): void {
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify({
        lifetimeBytesUp: this.status.lifetimeBytesUp,
        lifetimeBytesDown: this.status.lifetimeBytesDown,
        savedAt: Date.now(),
      }));
    } catch (e) {
      console.warn('[controller] persistStats failed:', (e as Error).message);
    }
    try {
      fs.writeFileSync(this.userStatsFile, JSON.stringify({
        users: this.cachedUserStats,
        savedAt: Date.now(),
      }));
    } catch (e) {
      console.warn('[controller] persistUserStats failed:', (e as Error).message);
    }
  }

  init(): void {
    if (fs.existsSync(this.sessionFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        const session: BaleSession = {
          jwt: raw.jwt,
          userId: BigInt(raw.userId),
          userName: raw.userName ?? null,
          userAccessHash: BigInt(raw.userAccessHash),
        };
        this.client.loadSession(session);
        this.onAuthenticated(session);
      } catch (e) {
        this.status.lastError = `failed to load saved session: ${(e as Error).message}`;
      }
    }
    this.emitStatus();
  }

  getStatus(): ServerStatus {
    return structuredClone(this.status);
  }

  async sendPhoneCode(phone: string): Promise<void> {
    console.log(`[controller] sendPhoneCode phone=${phone}`);
    this.status.lastError = null;
    try {
      const resp = await this.client.startPhoneAuth(phone);
      console.log(`[controller] startPhoneAuth OK transactionHash=${resp.transactionHash.slice(0, 16)}…`);
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

  async resendCode(): Promise<void> {
    if (!this.status.pendingPhone) throw new Error('no pending phone to resend');
    await this.sendPhoneCode(this.status.pendingPhone);
  }

  backToPhone(): void {
    this.pendingTransactionHash = null;
    this.status.loginStage = 'unauthenticated';
    this.status.lastError = null;
    this.emitStatus();
  }

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
    await this.stopServer();
    if (this.sidecar) { await this.sidecar.close(); this.sidecar = null; }
    if (fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile);
    this.status = {
      loginStage: 'unauthenticated',
      pendingPhone: null, me: null,
      running: false, tunnelsActive: 0, streamsActive: 0,
      bytesUp: 0, bytesDown: 0,
      // lifetime totals are persisted across signouts deliberately — they
      // describe the machine, not the logged-in account.
      lifetimeBytesUp: this.status.lifetimeBytesUp,
      lifetimeBytesDown: this.status.lifetimeBytesDown,
      startedAt: null,
      connections: [],
      // Users persist across signout — they describe the machine, not the account.
      users: this.status.users,
      logs: [],
      crashes: [],
      serverFingerprint: this.status.serverFingerprint,
      uploadEndpoint: this.status.uploadEndpoint ?? null,
      lastError: null,
    };
    this.peerLookupCache.clear();
    this.pendingPeerLookups.clear();
    this.peerLookupLastAttempt.clear();
    this.pendingTransactionHash = null;
    this.emitStatus();
  }

  /**
   * Start the server dispatcher using the currently-authenticated Bale session.
   * The password is the pre-shared key that all clients must know.
   */
  async startServer(password: string): Promise<void> {
    console.log(`[controller] startServer passwordLen=${password?.length ?? 0}`);
    if (!this.sidecar) {
      console.error('[controller] startServer refused: not authenticated');
      throw new Error('not authenticated');
    }
    if (this.status.running) {
      console.error('[controller] startServer refused: already running');
      throw new Error('server already running');
    }
    const psk = deriveKeyFromPassword(password, new TextEncoder().encode(PSK_SALT_INFO));
    console.log(`[controller] psk derived (${psk.byteLength} bytes)`);
    const manager = new TunnelManager();
    manager.loadLifetime({ up: this.status.lifetimeBytesUp, down: this.status.lifetimeBytesDown });
    manager.loadUserStats(this.cachedUserStats);
    manager.start();
    this.manager = manager;
    this.logStore = new ClientLogStore();
    this.crashStore = new CrashStore();
    this.serverIdentity = this.ensureServerIdentity();
    this.status.serverFingerprint = serverFingerprint(this.serverIdentity.publicKey);
    const onLogReport = (report: V2LogReport, tunnelId: string | null): void => {
      const summary = this.logStore?.add(report, tunnelId) ?? null;
      if (summary) {
        this.status.logs = this.logStore?.list() ?? [];
        this.emitStatus();
      }
    };

    // Start the local HTTP dashboard so clients can POST diagnostics even
    // when the tunnel is dead. PSK serves as the HMAC key for the
    // /api/client-logs and /api/crashes upload endpoints.
    const dashboardPort = Number(process.env.WT_DASHBOARD_PORT ?? '4402');
    const dashboardHost = process.env.WT_DASHBOARD_HOST ?? '127.0.0.1';
    try {
      this.dashboardHandles = startDashboard({
        manager,
        port: dashboardPort,
        host: dashboardHost,
        logStore: this.logStore,
        crashStore: this.crashStore,
        uploadHmacKey: psk,
      });
      this.status.uploadEndpoint = `http://${dashboardHost}:${dashboardPort}`;
      console.log(`[controller] dashboard + upload endpoint on ${this.status.uploadEndpoint}`);
    } catch (e) {
      console.warn(`[controller] dashboard failed to start: ${(e as Error).message}`);
      this.status.uploadEndpoint = null;
    }
    // Shared cache populated by the dispatcher right before calling the factory.
    const lastAcceptResultRef: { current: StartCallResult | null } = { current: null };
    const client = this.client;
    const wrappedClient = {
      ...client,
      acceptCall: async (callId: bigint, mediaFlag?: number) => {
        const r = await client.acceptCall(callId, mediaFlag ?? 1);
        lastAcceptResultRef.current = r;
        console.log(`[controller] acceptCall OK callId=${callId} roomUuid=${r.roomUuid} baseUrl=${r.baseUrl}`);
        return r;
      },
      // Proxy everything else the dispatcher needs
      startCall: client.startCall.bind(client),
      discardCall: client.discardCall.bind(client),
      receiveCall: client.receiveCall.bind(client),
      getWssURL: client.getWssURL.bind(client),
    } as unknown as BaleClient;
    const mode = process.env.WT_LIVEKIT_MODE;
    const session = this.client.currentSession();
    try {
      if (mode === 'mock') {
        this.mockBroker = await startLocalLivekitBroker({
          logger: (line) => console.log(line),
        });
        const mockFactory = makeLocalLivekitRoomFactory();
        const { stop } = await startWebrtcServer({
          factory: mockFactory,
          manager,
          identity: this.serverIdentity,
          protocolVersion: 2,
          roomSeed: psk,
          onLogReport,
          logger: (line) => console.log(`[server-webrtc] ${line}`),
        });
        this.webrtcStop = stop;
      } else {
        if (!session) throw new Error('Bale session missing while starting incoming-call watcher');
        this.incomingCalls = new BaleIncomingCallWatcher({
          session,
          logger: (line) => console.log(`[server-bale-ws] ${line}`),
        });
        await this.incomingCalls.start();
      }
    } catch (e) {
      await this.stopServer();
      this.status.lastError = `server start failed: ${(e as Error).message}`;
      this.emitStatus();
      throw e;
    }

    const dispatcher = new BaleServerDispatcher(this.sidecar, psk, manager, {
      logger: (line) => { console.log(`[server-dispatch] ${line}`); },
      protocolVersion: 2,
      identity: this.serverIdentity ?? undefined,
      onLogReport,
      ...(mode === 'mock'
        ? {}
        : {
            baleClient: wrappedClient,
            livekitFactory: buildServerLivekitFactory(lastAcceptResultRef),
            incomingCallSource: this.incomingCalls ?? undefined,
            restartIncomingCalls: async () => {
              if (!this.incomingCalls) return;
              await this.incomingCalls.restart();
            },
          }),
    });
    dispatcher.start();
    this.dispatcher = dispatcher;
    this.status.running = true;
    this.status.startedAt = Date.now();
    this.status.connections = [];
    this.status.logs = this.logStore?.list() ?? [];
    this.status.lastError = null;
    this.emitStatus();
    // Poll tunnel counts for the UI.
    const tick = setInterval(() => {
      if (!this.manager) {
        clearInterval(tick);
        if (this.statsTimer === tick) this.statsTimer = null;
        return;
      }
      const summary = this.manager.snapshot();
      // Only count tunnels that have a known protocol/client type — a tunnel
      // that's still handshaking shouldn't bump the dashboard counter.
      const active = summary.filter((t) => t.protocolVersion != null || t.clientType != null);
      this.status.tunnelsActive = active.length;
      this.status.streamsActive = active.reduce((a, s) => a + s.streamsActive, 0);
      this.status.bytesUp = active.reduce((a, s) => a + s.bytesUp, 0);
      this.status.bytesDown = active.reduce((a, s) => a + s.bytesDown, 0);
      const lifetime = this.manager.getLifetime();
      this.status.lifetimeBytesUp = lifetime.up;
      this.status.lifetimeBytesDown = lifetime.down;
      this.cachedUserStats = this.manager.listUsers();
      this.refreshUserStats(active);
      this.refreshConnectionDetails(active);
      this.queuePeerLookups(active);
      this.status.logs = this.logStore?.list() ?? [];
      this.status.crashes = this.crashStore?.list() ?? [];
      this.emitStatus();
    }, 1000);
    this.statsTimer = tick;
    if (typeof (tick as unknown as { unref?: () => void }).unref === 'function') {
      (tick as unknown as { unref: () => void }).unref();
    }
    // Persist lifetime totals every 60 s so a crash/restart preserves them.
    const persist = setInterval(() => this.persistStats(), 60_000);
    if (typeof (persist as unknown as { unref?: () => void }).unref === 'function') {
      (persist as unknown as { unref: () => void }).unref();
    }
    this.statsPersistTimer = persist;
  }

  async stopServer(): Promise<void> {
    console.log('[controller] stopServer');
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.statsPersistTimer) {
      clearInterval(this.statsPersistTimer);
      this.statsPersistTimer = null;
    }
    // Persist one final time so we don't lose the in-flight bytes.
    if (this.manager) {
      const lifetime = this.manager.getLifetime();
      this.status.lifetimeBytesUp = lifetime.up;
      this.status.lifetimeBytesDown = lifetime.down;
      // Keep the per-user cache fresh so it survives the impending stop.
      this.cachedUserStats = this.manager.listUsers();
      this.persistStats();
    }
    if (this.dispatcher) { this.dispatcher.stop(); this.dispatcher = null; }
    if (this.incomingCalls) {
      await this.incomingCalls.close();
      this.incomingCalls = null;
    }
    if (this.webrtcStop) {
      await this.webrtcStop();
      this.webrtcStop = null;
    }
    if (this.mockBroker) {
      await this.mockBroker.close();
      this.mockBroker = null;
    }
    if (this.dashboardHandles) {
      try { await this.dashboardHandles.close(); } catch (e) {
        console.warn(`[controller] dashboard close failed: ${(e as Error).message}`);
      }
      this.dashboardHandles = null;
    }
    if (this.manager) { this.manager.stop(); this.manager = null; }
    this.logStore = null;
    this.crashStore = null;
    this.status.uploadEndpoint = null;
    this.status.running = false;
    this.status.startedAt = null;
    this.status.tunnelsActive = 0;
    this.status.streamsActive = 0;
    this.status.bytesUp = 0;
    this.status.bytesDown = 0;
    this.status.connections = [];
    this.status.logs = [];
    // Keep showing all users (with active=0) even after the server stops —
    // operator should still be able to see and reset them.
    this.refreshUserStats([]);
    this.emitStatus();
  }

  async terminateConnection(id: string, reason = 'terminated by server operator'): Promise<void> {
    if (!this.manager) throw new Error('server is not running');
    const ok = await this.manager.terminateTunnel(id, reason);
    if (!ok) throw new Error('connection not found or not terminable');
  }

  /**
   * Zero out one user's cumulative bytes. Works whether the server is running
   * or not — when running, also tells the manager to update its in-memory map.
   * The user record stays in the list so the operator always sees them.
   */
  async resetUser(peerKey: string): Promise<void> {
    if (this.manager) {
      const ok = this.manager.resetUser(peerKey);
      if (!ok && !this.cachedUserStats.find((u) => u.peerKey === peerKey)) {
        throw new Error(`user not found: ${peerKey}`);
      }
      this.cachedUserStats = this.manager.listUsers();
    } else {
      const idx = this.cachedUserStats.findIndex((u) => u.peerKey === peerKey);
      const existing = idx >= 0 ? this.cachedUserStats[idx] : null;
      if (!existing) throw new Error(`user not found: ${peerKey}`);
      this.cachedUserStats[idx] = {
        peerKey: existing.peerKey,
        chatId: existing.chatId,
        chatType: existing.chatType,
        name: existing.name,
        username: existing.username,
        firstSeen: existing.firstSeen,
        bytesUp: 0,
        bytesDown: 0,
        lastSeen: Date.now(),
      };
    }
    this.refreshUserStats(this.manager?.snapshot() ?? []);
    this.persistStats();
    this.emitStatus();
  }

  private refreshUserStats(snapshot: TunnelSnapshot[]): void {
    const activeByPeer = new Map<string, string[]>();
    for (const t of snapshot) {
      if (!t.peer) continue;
      const key = `${t.peer.chatType}:${t.peer.chatId}`;
      const ids = activeByPeer.get(key) ?? [];
      ids.push(t.id);
      activeByPeer.set(key, ids);
    }
    this.status.users = this.cachedUserStats.map((u) => {
      const ids = activeByPeer.get(u.peerKey) ?? [];
      return {
        ...toServerUserStats(u),
        activeConnections: ids.length,
        activeTunnelIds: ids,
      };
    });
  }

  listLogs(): ClientLogSummary[] {
    return this.logStore?.list() ?? [];
  }

  getLog(id: string): string | null {
    return this.logStore?.get(id)?.body ?? null;
  }

  async dispose(): Promise<void> {
    await this.stopServer();
    if (this.sidecar) { await this.sidecar.close(); this.sidecar = null; }
  }

  /**
   * Record a process-level error (uncaughtException / unhandledRejection) so
   * the dashboard surfaces it without taking the server down. The crash store
   * ingests it; the dashboard renders it in the Crashes card.
   */
  async recordProcessError(kind: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack ?? '' : '';
    console.error(`[controller] ${kind}: ${message}\n${stack}`);
    this.status.lastError = `${kind}: ${message}`;
    if (this.crashStore) {
      try {
        this.crashStore.add({
          source: 'server-electron',
          appVersion: '0.3-beta',
          occurredAt: Date.now(),
          kind,
          message,
          stack,
        });
        this.status.crashes = this.crashStore.list();
      } catch { /* ignore */ }
    }
    this.emitStatus();
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
    const identity = this.ensureServerIdentity();
    this.status.loginStage = 'ready';
    this.status.me = {
      id: Number(session.userId),
      name: session.userName,
      phone: null,
    };
    this.status.serverFingerprint = serverFingerprint(identity.publicKey);
    this.status.lastError = null;
    this.pendingTransactionHash = null;
    this.emitStatus();
  }

  private refreshConnectionDetails(snapshot: TunnelSnapshot[] = this.manager?.snapshot() ?? []): void {
    // Hide tunnels that are still mid-handshake (no clientType yet AND no
    // bytes ever transferred) to keep the operator's view clean. The
    // dispatcher will close them on hard timeout if the handshake never
    // arrives. Tunnels that ever transferred bytes stay visible regardless.
    const interesting = snapshot.filter((tunnel) => {
      const hasIdentity = tunnel.clientType != null || tunnel.protocolVersion != null;
      const hasTraffic = tunnel.bytesUp > 0 || tunnel.bytesDown > 0 || tunnel.streamsOpened > 0;
      return hasIdentity || hasTraffic;
    });
    this.status.connections = interesting
      .map((tunnel) => {
      const peer = this.withResolvedPeer(tunnel.peer);
      const userLabel = peer ? formatUserLabel(peer) : tunnel.label;
      const peerLabel = peer ? formatPeerLabel(peer) : tunnel.label;
      return {
        id: tunnel.id,
        label: tunnel.label,
        carrier: tunnel.carrier,
        protocolVersion: tunnel.protocolVersion,
        terminable: tunnel.terminable,
        terminationState: tunnel.terminationState,
        openedAt: tunnel.openedAt,
        userLabel,
        peerLabel,
        username: peer?.username ?? null,
        clientType: tunnel.clientType,
        clientVersion: tunnel.clientVersion,
        streamsOpened: tunnel.streamsOpened,
        streamsActive: tunnel.streamsActive,
        bytesUp: tunnel.bytesUp,
        bytesDown: tunnel.bytesDown,
        totalBytes: tunnel.bytesUp + tunnel.bytesDown,
        streams: tunnel.streams.map((stream) => ({
          streamId: stream.streamId,
          target: formatTarget(stream.addr),
          openedAt: stream.openedAt,
          bytesUp: stream.bytesUp,
          bytesDown: stream.bytesDown,
        })),
      };
      });
  }

  private withResolvedPeer(peer: TunnelPeerSummary | null): TunnelPeerSummary | null {
    if (!peer) return null;
    const cached = this.peerLookupCache.get(peerKey(peer));
    if (!cached) return peer;
    return {
      ...peer,
      name: peer.name ?? cached.name,
      username: peer.username ?? cached.username,
    };
  }

  private queuePeerLookups(snapshot: TunnelSnapshot[]): void {
    const now = Date.now();
    const pending: TunnelPeerSummary[] = [];
    for (const tunnel of snapshot) {
      const peer = tunnel.peer;
      if (!peer) continue;
      if (peer.chatType !== 'PRIVATE' && peer.chatType !== 'BOT') continue;
      if (peer.name || this.peerLookupCache.has(peerKey(peer)) || this.pendingPeerLookups.has(peerKey(peer))) continue;
      const lastAttempt = this.peerLookupLastAttempt.get(peerKey(peer)) ?? 0;
      if (now - lastAttempt < 30_000) continue;
      this.pendingPeerLookups.add(peerKey(peer));
      this.peerLookupLastAttempt.set(peerKey(peer), now);
      pending.push(peer);
    }
    if (pending.length === 0) return;

    void (async () => {
      try {
        const users = await this.client.loadUsers(pending.map((peer) => ({
          id: BigInt(peer.chatId),
          type: toBaleChatType(peer.chatType),
        })));
        const byId = new Map(users.map((user) => [Number(user.id), user] as const));
        const current = this.manager?.snapshot() ?? [];
        for (const peer of pending) {
          const resolved = byId.get(peer.chatId);
          const cached = {
            name: resolved?.name ?? null,
            username: resolved?.username ?? null,
          };
          this.peerLookupCache.set(peerKey(peer), cached);
          for (const tunnel of current) {
            if (!tunnel.peer || peerKey(tunnel.peer) !== peerKey(peer)) continue;
            this.manager?.updateTunnel(tunnel.id, {
              peer: {
                ...tunnel.peer,
                name: cached.name,
                username: cached.username,
              },
            });
          }
        }
        this.refreshConnectionDetails();
        this.emitStatus();
      } catch (e) {
        console.warn('[controller] loadUsers failed:', (e as Error).message);
      } finally {
        for (const peer of pending) this.pendingPeerLookups.delete(peerKey(peer));
      }
    })();
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }

  private ensureServerIdentity(): V2ServerIdentity {
    if (this.serverIdentity) return this.serverIdentity;
    try {
      if (fs.existsSync(this.identityFile)) {
        const raw = JSON.parse(fs.readFileSync(this.identityFile, 'utf8')) as { privateKey?: string };
        if (typeof raw.privateKey === 'string' && raw.privateKey.length > 0) {
          const privateKey = new Uint8Array(Buffer.from(raw.privateKey, 'base64'));
          this.serverIdentity = createV2ServerIdentityFromPrivateKey(privateKey);
          return this.serverIdentity;
        }
      }
    } catch {
      // fall through and regenerate
    }
    const privateKey = crypto.getRandomValues(new Uint8Array(32));
    this.serverIdentity = createV2ServerIdentityFromPrivateKey(privateKey);
    fs.writeFileSync(
      this.identityFile,
      JSON.stringify({
        privateKey: Buffer.from(privateKey).toString('base64'),
        publicKey: Buffer.from(this.serverIdentity.publicKey).toString('base64'),
      }, null, 2),
    );
    return this.serverIdentity;
  }
}

/**
 * Build a LivekitRoomFactory the server uses to JOIN the call room when a
 * client offers a meet-call. The dispatcher has already called
 * `BaleClient.acceptCall(callId)` and has the URL+JWT cached; the factory
 * stored in `lastAcceptResult` supplies them to `connectLivekitRoom`.
 */
function buildServerLivekitFactory(lastAcceptResultRef: { current: StartCallResult | null }): LivekitRoomFactory {
  return async (ctx) => {
    // The dispatcher stores the AcceptCall result just before calling us, so
    // we have a URL+JWT to connect with. If it's missing, that's a wiring bug.
    const accept = lastAcceptResultRef.current;
    if (!accept) {
      throw new Error('server livekit factory invoked but no AcceptCall result cached');
    }
    const url = buildLiveKitUrl(accept);
    return connectLivekitRoom(url, ctx);
  };
}

function peerKey(peer: TunnelPeerSummary): string {
  return `${peer.chatType}:${peer.chatId}`;
}

function toServerUserStats(u: UserStats): ServerUserStats {
  return {
    peerKey: u.peerKey,
    chatId: u.chatId,
    chatType: u.chatType,
    name: u.name,
    username: u.username,
    bytesUp: u.bytesUp,
    bytesDown: u.bytesDown,
    totalBytes: u.bytesUp + u.bytesDown,
    firstSeen: u.firstSeen,
    lastSeen: u.lastSeen,
    activeConnections: 0,
    activeTunnelIds: [],
  };
}

function formatTarget(addr: { kind: string; host: string; port: number }): string {
  return `${addr.host}:${addr.port}`;
}

function formatUserLabel(peer: TunnelPeerSummary): string {
  if (peer.name && peer.name.trim()) return peer.name.trim();
  if (peer.username && peer.username.trim()) return `@${peer.username.trim()}`;
  return `${peer.chatType} ${peer.chatId}`;
}

function formatPeerLabel(peer: TunnelPeerSummary): string {
  if (peer.username && peer.username.trim()) {
    return `${peer.chatType} ${peer.chatId} • @${peer.username.trim()}`;
  }
  return `${peer.chatType} ${peer.chatId}`;
}

function toBaleChatType(chatType: string): BaleChatType | undefined {
  switch (chatType) {
    case 'PRIVATE':
      return BaleChatType.PRIVATE;
    case 'GROUP':
      return BaleChatType.GROUP;
    case 'CHANNEL':
      return BaleChatType.CHANNEL;
    case 'BOT':
      return BaleChatType.BOT;
    case 'SUPER_GROUP':
      return BaleChatType.SUPER_GROUP;
    default:
      return undefined;
  }
}
