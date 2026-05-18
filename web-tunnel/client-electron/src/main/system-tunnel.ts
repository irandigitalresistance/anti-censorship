import { spawn, type ChildProcess, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';

export type SystemTunnelStatus = 'off' | 'starting' | 'on' | 'error';

export interface SystemTunnelEvents {
  status: (status: SystemTunnelStatus, detail: string | null) => void;
  log: (line: string) => void;
}

export interface SystemTunnelOptions {
  /** Absolute path to sing-box.exe. If null, system tunnel is unavailable. */
  singBoxPath: string | null;
  /** Local SOCKS5 port we forward all system traffic into. */
  socksPort: number;
  /** Working dir for generated config + child stdout/stderr. */
  runtimeDir?: string;
}

/**
 * Spawns sing-box.exe with a TUN inbound that captures all system traffic and
 * forwards it through our local SOCKS5 listener. Mirrors the Hiddify approach.
 *
 * Lifecycle:
 *   - new SystemTunnel({...})
 *   - await sysTunnel.start()  → 'starting' → 'on' (or throws if not admin)
 *   - sysTunnel.stop()         → 'off'
 *
 * REQUIRES the parent Electron process to be running as Administrator. The
 * spawned sing-box inherits that token.
 */
export class SystemTunnel extends EventEmitter {
  private status: SystemTunnelStatus = 'off';
  private statusDetail: string | null = null;
  private child: ChildProcess | null = null;
  private readonly runtimeDir: string;
  private readonly configFile: string;
  private readonly logFile: string;

  constructor(private opts: SystemTunnelOptions) {
    super();
    this.runtimeDir = opts.runtimeDir
      ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'NovaNet');
    if (!fs.existsSync(this.runtimeDir)) fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.configFile = path.join(this.runtimeDir, 'sing-box.json');
    this.logFile = path.join(this.runtimeDir, 'sing-box.log');
  }

  getStatus(): { status: SystemTunnelStatus; detail: string | null } {
    return { status: this.status, detail: this.statusDetail };
  }

  /**
   * Detect Administrator privilege on Windows. Tries several mechanisms in
   * order — `net session` is the cheapest, but it doesn't always work on
   * locked-down hosts (some Group Policy configs disable it). PowerShell's
   * `WindowsPrincipal.IsInRole` is the authoritative answer on every Windows
   * SKU. Either method returning admin is enough; both failing means we're
   * not elevated.
   */
  static isElevated(): boolean {
    if (process.platform !== 'win32') return false;
    // Method 1: `net session` (fast, ~50ms)
    try {
      execSync('net session', { stdio: 'ignore' });
      return true;
    } catch {
      // fall through
    }
    // Method 2: PowerShell WindowsPrincipal (definitive, ~400ms)
    try {
      const out = execSync(
        'powershell -NoProfile -NonInteractive -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"',
        { encoding: 'utf8', timeout: 4000 },
      );
      return /true/i.test(out.trim());
    } catch {
      return false;
    }
  }

  /** Generate the JSON sing-box config for our SOCKS5 upstream. */
  private writeConfig(): void {
    const cfg = {
      log: { level: 'warn', timestamp: true },
      inbounds: [{
        type: 'tun',
        tag: 'tun-in',
        address: ['172.18.0.1/30', 'fd00:1::1/126'],
        mtu: 1492,
        auto_route: true,
        strict_route: true,
        stack: 'gvisor',
        endpoint_independent_nat: true,
      }],
      outbounds: [
        {
          type: 'socks',
          tag: 'socks-out',
          server: '127.0.0.1',
          server_port: this.opts.socksPort,
          version: '5',
        },
        { type: 'direct', tag: 'direct' },
        { type: 'block', tag: 'block' },
      ],
      route: {
        auto_detect_interface: true,
        final: 'socks-out',
        rules: [
          // Don't loop traffic to our own SOCKS through TUN.
          { ip_cidr: ['127.0.0.0/8', '::1/128'], outbound: 'direct' },
          // Local network: send direct so LAN doesn't route over the tunnel.
          { ip_cidr: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10'], outbound: 'direct' },
        ],
      },
    };
    fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2));
  }

  async start(): Promise<void> {
    if (this.status === 'on' || this.status === 'starting') return;
    if (process.platform !== 'win32') {
      this.setStatus('error', 'system tunnel is Windows-only in this build');
      throw new Error('system tunnel is Windows-only');
    }
    if (!SystemTunnel.isElevated()) {
          this.setStatus('error', 'must run NovaNet as Administrator to enable system tunnel');
      throw new Error('not elevated');
    }
    if (!this.opts.singBoxPath || !fs.existsSync(this.opts.singBoxPath)) {
      this.setStatus(
        'error',
        `sing-box.exe not found at ${this.opts.singBoxPath ?? '(unset)'}. ` +
        `Place sing-box.exe in client-electron/resources/sing-box/ first.`,
      );
      throw new Error('sing-box.exe missing');
    }
    this.setStatus('starting', 'launching sing-box...');
    this.writeConfig();
    const out = createWriteStream(this.logFile, { flags: 'a' });
    out.write(`\n========== ${new Date().toISOString()} system tunnel start ==========\n`);
    const child = spawn(this.opts.singBoxPath, ['run', '-c', this.configFile], {
      cwd: this.runtimeDir,
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out.write(text);
      this.emit('log', text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out.write(`[stderr] ${text}`);
      this.emit('log', `[stderr] ${text}`);
    });
    child.on('exit', (code, signal) => {
      out.write(`\n[exit] code=${code} signal=${signal}\n`);
      out.end();
      this.child = null;
      const wasOn = this.status === 'on';
      if (this.status !== 'off') {
        this.setStatus('error', `sing-box exited with code=${code} signal=${signal}`);
      }
      if (wasOn) {
        // Unexpected death — leave status as error so UI can prompt.
      }
    });
    // Optimistically mark on after a short bring-up grace period; sing-box
    // does not signal "ready" but emits config logs within ~1s.
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    if (this.child && (this.status as SystemTunnelStatus) === 'starting') {
      this.setStatus('on', 'system tunnel active');
    }
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.setStatus('off', null);
      return;
    }
    const child = this.child;
    this.child = null;
    this.setStatus('off', null);
    try {
      // SIGTERM doesn't exist on Windows for child_process; use taskkill /T /F.
      if (process.platform === 'win32' && child.pid != null) {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  }

  private setStatus(status: SystemTunnelStatus, detail: string | null): void {
    this.status = status;
    this.statusDetail = detail;
    this.emit('status', status, detail);
  }
}

/**
 * Resolve the bundled sing-box.exe path, or null if missing.
 *
 * In a packaged build the file is shipped via electron-builder's
 * `extraResources` directive, so it lives at `<resourcesPath>/sing-box/`.
 * In dev (`pnpm dev`), it lives at `client-electron/resources/sing-box/`.
 */
export function resolveBundledSingBox(appPath: string, isPackaged: boolean): string | null {
  const candidates: string[] = [];
  if (isPackaged) {
    // process.resourcesPath is the canonical location for extraResources.
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'sing-box', 'sing-box.exe'));
    }
    candidates.push(
      path.join(path.dirname(appPath), 'sing-box', 'sing-box.exe'),
      path.join(path.dirname(appPath), 'resources', 'sing-box', 'sing-box.exe'),
      path.join(appPath, 'resources', 'sing-box', 'sing-box.exe'),
    );
  } else {
    candidates.push(
      path.resolve(appPath, 'resources', 'sing-box', 'sing-box.exe'),
      path.resolve(appPath, '..', 'resources', 'sing-box', 'sing-box.exe'),
    );
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore — keep trying
    }
  }
  return null;
}
