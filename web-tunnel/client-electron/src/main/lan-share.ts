import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';

export type LanShareStatus = 'off' | 'starting' | 'on' | 'error';

export interface LanShareOptions {
  /** Path to the bundled sing-box.exe (we reuse it as a vmess inbound). */
  singBoxPath: string | null;
  /** Local SOCKS5 port to forward shared traffic into. */
  socksPort: number;
  /** Preferred listen port; falls back to next free in 10086..10200. */
  preferredPort?: number;
  /** Where to keep the persisted UUID + sing-box config + log. */
  runtimeDir?: string;
}

export interface LanShareInfo {
  port: number;
  host: string;
  uuid: string;
  vmessUrl: string;
}

/**
 * LAN share = a vmess-none inbound on 0.0.0.0 that forwards into our local
 * SOCKS5. Gives any device on the same Wi-Fi a one-tap tunnel via v2rayN /
 * v2rayNG. No encryption (LAN is trusted; max throughput).
 */
export class LanShare extends EventEmitter {
  private status: LanShareStatus = 'off';
  private statusDetail: string | null = null;
  private info: LanShareInfo | null = null;
  private child: ChildProcess | null = null;
  private readonly runtimeDir: string;
  private readonly stateFile: string;
  private readonly configFile: string;
  private readonly logFile: string;

  constructor(private opts: LanShareOptions) {
    super();
    this.runtimeDir = opts.runtimeDir
      ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'WebTunnel');
    if (!fs.existsSync(this.runtimeDir)) fs.mkdirSync(this.runtimeDir, { recursive: true });
    this.stateFile = path.join(this.runtimeDir, 'lan-share.json');
    this.configFile = path.join(this.runtimeDir, 'lan-share.json5');
    this.logFile = path.join(this.runtimeDir, 'lan-share.log');
  }

  getStatus(): { status: LanShareStatus; detail: string | null; info: LanShareInfo | null } {
    return { status: this.status, detail: this.statusDetail, info: this.info };
  }

  async start(): Promise<LanShareInfo> {
    if (this.status === 'on' && this.info) return this.info;
    if (process.platform !== 'win32') {
      this.setStatus('error', 'LAN share is Windows-only in this build');
      throw new Error('LAN share is Windows-only');
    }
    if (!this.opts.singBoxPath || !fs.existsSync(this.opts.singBoxPath)) {
      this.setStatus('error', 'sing-box.exe not found — see resources/sing-box/README.md');
      throw new Error('sing-box.exe missing');
    }
    this.setStatus('starting', 'picking port...');
    const port = await this.pickFreePort(this.opts.preferredPort ?? 10086);
    const uuid = this.loadOrCreateUuid();
    const host = pickLanIPv4() ?? '0.0.0.0';
    // VMess AEAD defaults: omit `alterId` and `security` so sing-box uses the
    // modern AEAD path. v2rayN/v2rayNG default to `scy: auto` which negotiates
    // the cipher with the server. The previous config set `security: 'none'`
    // on the inbound which is the legacy non-AEAD mode and broke clients.
    const cfg = {
      log: { level: 'warn', timestamp: true },
      inbounds: [{
        type: 'vmess',
        tag: 'lan-vmess',
        listen: '0.0.0.0',
        listen_port: port,
        users: [{ name: 'lan', uuid }],
      }],
      outbounds: [
        {
          type: 'socks',
          tag: 'socks-out',
          server: '127.0.0.1',
          server_port: this.opts.socksPort,
          version: '5',
        },
      ],
      route: { final: 'socks-out' },
    };
    fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2));
    const out = createWriteStream(this.logFile, { flags: 'a' });
    out.write(`\n========== ${new Date().toISOString()} lan share start (port=${port}) ==========\n`);
    const child = spawn(this.opts.singBoxPath, ['run', '-c', this.configFile], {
      cwd: this.runtimeDir,
      windowsHide: true,
    });
    this.child = child;
    let exitedDuringBringup = false;
    let exitDetail = '';
    child.stdout?.on('data', (chunk: Buffer) => out.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => out.write(chunk));
    child.on('exit', (code, signal) => {
      out.write(`\n[exit] code=${code} signal=${signal}\n`);
      out.end();
      this.child = null;
      exitedDuringBringup = true;
      exitDetail = `code=${code}${signal ? ` signal=${signal}` : ''}`;
      if (this.status !== 'off') {
        this.setStatus('error', `sing-box (lan share) exited ${exitDetail}`);
      }
    });
    // Give sing-box a moment to bind the listener — if it dies in this window
    // the exit handler above already flipped status to 'error' and we must
    // NOT subsequently flip to 'on'. Previously this race made the toggle
    // briefly show OFF then flicker back to ON.
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
    if (exitedDuringBringup || !this.child) {
      throw new Error(`sing-box (lan share) failed to start: ${exitDetail || 'process exited'}`);
    }
    const info: LanShareInfo = {
      port,
      host,
      uuid,
      vmessUrl: buildVmessUrl({ host, port, uuid }),
    };
    this.info = info;
    this.setStatus('on', `vmess://… on ${host}:${port}`);
    return info;
  }

  async stop(): Promise<void> {
    this.info = null;
    if (!this.child) {
      this.setStatus('off', null);
      return;
    }
    const child = this.child;
    this.child = null;
    this.setStatus('off', null);
    try {
      if (process.platform === 'win32' && child.pid != null) {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch { /* ignore */ }
  }

  private async pickFreePort(preferred: number): Promise<number> {
    const start = preferred;
    const end = Math.max(preferred + 100, 10200);
    for (let p = start; p <= end; p += 1) {
      if (await isPortFree(p)) return p;
    }
    throw new Error(`no free port in ${start}..${end}`);
  }

  private loadOrCreateUuid(): string {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as { uuid?: string };
        if (raw.uuid && /^[0-9a-f-]{36}$/i.test(raw.uuid)) return raw.uuid;
      }
    } catch { /* ignore */ }
    const uuid = crypto.randomUUID();
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ uuid })); } catch { /* ignore */ }
    return uuid;
  }

  private setStatus(status: LanShareStatus, detail: string | null): void {
    this.status = status;
    this.statusDetail = detail;
    this.emit('status', status, detail, this.info);
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Pick the first non-loopback IPv4 in a private range. */
export function pickLanIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // Prefer 192.168.* > 10.* > 172.16-31.*
      if (/^192\.168\./.test(iface.address)) return iface.address;
    }
  }
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (/^10\./.test(iface.address)) return iface.address;
      if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(iface.address)) return iface.address;
    }
  }
  return null;
}

/**
 * Build a v2rayN/v2rayNG-compatible vmess:// URL for the given listener.
 *
 * Fields:
 *  - `aid: 0`         → AEAD mode (legacy alterId disabled)
 *  - `scy: "auto"`    → cipher negotiation; matches sing-box defaults
 *  - `net: "tcp"`, `type: "none"` → plain TCP, no obfuscation header
 *  - `tls: ""`        → no TLS (LAN is trusted, max throughput)
 */
export function buildVmessUrl(args: { host: string; port: number; uuid: string }): string {
  const payload = {
    v: '2',
    ps: 'WebTunnel-LAN',
    add: args.host,
    port: String(args.port),
    id: args.uuid,
    aid: '0',
    scy: 'auto',
    net: 'tcp',
    type: 'none',
    host: '',
    path: '',
    tls: '',
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `vmess://${b64}`;
}
