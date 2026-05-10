import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { APP_VERSION_LABEL } from '@webtunnel/shared';
import { Controller } from './controller.js';
import { buildLivekitFactory } from './livekit-factory-wiring.js';
import { installFileLogger } from './file-logger.js';
import { SystemTunnel, resolveBundledSingBox } from './system-tunnel.js';
import { LanShare } from './lan-share.js';

// esbuild bundles to CJS, so __dirname is available as a CJS global.
declare const __dirname: string;

const logFilePath = installFileLogger('client');
console.log(`[main] client-electron starting, pid=${process.pid}, platform=${process.platform}`);

const livekitFactory = buildLivekitFactory();
console.log(`[main] livekitFactory installed=${!!livekitFactory} (WT_LIVEKIT_MODE=${process.env.WT_LIVEKIT_MODE ?? 'unset'})`);
const controller = new Controller({ livekitFactory: livekitFactory ?? undefined, logFilePath });

const isAdmin = SystemTunnel.isElevated();
console.log(`[main] elevated=${isAdmin}`);
const singBoxPath = resolveBundledSingBox(app.getAppPath(), app.isPackaged);
console.log(`[main] singBoxPath=${singBoxPath ?? '(missing)'}`);
let systemTunnel: SystemTunnel | null = null;
let lanShare: LanShare | null = null;

let mainWindow: BrowserWindow | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

function createWindow(): void {
  const appRoot = app.isPackaged ? path.dirname(app.getAppPath()) : path.resolve(__dirname, '../..');
  const preloadPath = app.isPackaged
    ? path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs')
    : path.resolve(__dirname, 'preload.cjs');
  const rendererIndex = app.isPackaged
    ? path.join(app.getAppPath(), 'src', 'renderer', 'index.html')
    : path.resolve(__dirname, '../../src/renderer/index.html');

  mainWindow = new BrowserWindow({
    width: 820,
    height: 680,
    backgroundColor: '#0e0f12',
    title: `Web Tunnel ${APP_VERSION_LABEL}`,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error('[main] preload failed:', p, err);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(rendererIndex);
  // Auto-open DevTools so renderer errors + IPC traffic are visible.
  mainWindow.webContents.openDevTools({ mode: 'detach' });
  void appRoot;

  controller.on('status', (status) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    const contents = win.webContents;
    if (contents.isDestroyed()) return;
    try {
      contents.send('status:change', status);
    } catch (e) {
      console.warn('[main] status send failed:', (e as Error).message);
    }
  });
}

ipcMain.handle('caps:get', () => ({
  hasWebrtc: controller.hasWebrtc(),
  logFile: logFilePath,
  isAdmin,
  singBoxAvailable: singBoxPath != null,
}));
ipcMain.handle('log:open', async () => {
  try { await shell.openPath(logFilePath); return logFilePath; }
  catch (e) { return `failed: ${(e as Error).message}`; }
});
ipcMain.handle('status:get', () => controller.getStatus());
ipcMain.handle('auth:send-code', async (_e, phone: string) => controller.sendPhoneCode(phone));
ipcMain.handle('auth:resend-code', async () => controller.resendCode());
ipcMain.handle('auth:verify-code', async (_e, code: string) => controller.verifyCode(code));
ipcMain.handle('auth:verify-password', async (_e, pw: string) => controller.verifyPassword(pw));
ipcMain.handle('auth:back-to-phone', () => controller.backToPhone());
ipcMain.handle('auth:back-to-code', () => controller.backToCode());
ipcMain.handle('auth:sign-out', async () => controller.signOut());
ipcMain.handle('config:import', async (_e, config: string) => controller.importClientConfig(config));
ipcMain.handle('chats:list', async () => controller.listChats());
ipcMain.handle('tunnel:start', async (_e, opts) => controller.startTunnel(opts));
ipcMain.handle('tunnel:stop', async () => controller.stopTunnel());
ipcMain.handle('logs:send', async () => controller.sendLogs());
ipcMain.handle('keys:reset-pin', async (_e, keyId?: string | null) => controller.resetPinnedKey(keyId ?? null));
ipcMain.handle('tunnel:speedtest', async () => controller.speedTest());

// ----- System tunnel (Hiddify-style whole-system TUN via sing-box). -----
function ensureSystemTunnel(): SystemTunnel {
  const tunnel = controller.getStatus().tunnel;
  if (!tunnel) throw new Error('start the SOCKS tunnel first');
  if (!systemTunnel) {
    systemTunnel = new SystemTunnel({ singBoxPath, socksPort: tunnel.socksPort });
    systemTunnel.on('status', (status, detail) => {
      const win = mainWindow;
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('system-tunnel:status', { status, detail }); } catch { /* ignore */ }
      }
    });
  }
  return systemTunnel;
}
ipcMain.handle('system-tunnel:status', () => systemTunnel?.getStatus() ?? { status: 'off', detail: null });
ipcMain.handle('system-tunnel:start', async () => {
  const t = ensureSystemTunnel();
  await t.start();
  return t.getStatus();
});
ipcMain.handle('system-tunnel:stop', async () => {
  if (!systemTunnel) return { status: 'off', detail: null };
  await systemTunnel.stop();
  return systemTunnel.getStatus();
});

// ----- LAN share (vmess listener for other devices on the same Wi-Fi). -----
function ensureLanShare(): LanShare {
  const tunnel = controller.getStatus().tunnel;
  if (!tunnel) throw new Error('start the SOCKS tunnel first');
  if (!lanShare) {
    lanShare = new LanShare({ singBoxPath, socksPort: tunnel.socksPort });
    lanShare.on('status', (status, detail, info) => {
      const win = mainWindow;
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('lan-share:status', { status, detail, info }); } catch { /* ignore */ }
      }
    });
  }
  return lanShare;
}
ipcMain.handle('lan-share:status', () => lanShare?.getStatus() ?? { status: 'off', detail: null, info: null });
ipcMain.handle('lan-share:start', async () => {
  const ls = ensureLanShare();
  await ls.start();
  return ls.getStatus();
});
ipcMain.handle('lan-share:stop', async () => {
  if (!lanShare) return { status: 'off', detail: null, info: null };
  await lanShare.stop();
  return lanShare.getStatus();
});
// Render a QR code for the given text into a PNG data URL. Used by the
// renderer to display the LAN-share vmess URL as a scannable QR.
ipcMain.handle('lan-share:qr', async (_e, text: string) => {
  if (!text || typeof text !== 'string') throw new Error('qr: text required');
  const QR = require('qrcode') as typeof import('qrcode');
  return await QR.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
    color: { dark: '#0e0f12', light: '#ffffff' },
  });
});

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[main] shutdown: ${reason}`);
  try {
    if (systemTunnel) await systemTunnel.stop();
  } catch (e) { console.warn('[main] systemTunnel stop:', (e as Error).message); }
  try {
    if (lanShare) await lanShare.stop();
  } catch (e) { console.warn('[main] lanShare stop:', (e as Error).message); }
  try {
    await Promise.race([
      controller.dispose(),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ]);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[main] dispose error:', (e as Error).message);
  }
  app.quit();
  setImmediate(() => process.exit(0));
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  createWindow();
  controller.init();
});

app.on('window-all-closed', () => void shutdown('all windows closed'));
app.on('before-quit', () => void shutdown('before-quit'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Capture crashes to disk for the next sendLogs upload, but don't quit. The
// renderer will surface lastError so the user notices something went wrong.
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error);
  controller.recordCrash('uncaughtException', error).catch((e) => {
    console.warn('[main] recordCrash failed:', (e as Error).message);
  });
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
  controller.recordCrash('unhandledRejection', reason).catch((e) => {
    console.warn('[main] recordCrash failed:', (e as Error).message);
  });
});
