import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { APP_VERSION_LABEL } from '@webtunnel/shared';
import { ServerController } from './controller.js';
import { installFileLogger } from './file-logger.js';

// esbuild bundles to CJS, so __dirname is available as a CJS global.
declare const __dirname: string;

const logFilePath = installFileLogger('server');
console.log(`[main] server-electron starting, pid=${process.pid}, platform=${process.platform}`);

const controller = new ServerController();
let mainWindow: BrowserWindow | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

function createWindow(): void {
  const preloadPath = app.isPackaged
    ? path.join(app.getAppPath(), 'dist', 'main', 'preload.cjs')
    : path.resolve(__dirname, 'preload.cjs');
  const rendererIndex = app.isPackaged
    ? path.join(app.getAppPath(), 'src', 'renderer', 'index.html')
    : path.resolve(__dirname, '../../src/renderer/index.html');

  mainWindow = new BrowserWindow({
    width: 820, height: 640,
    backgroundColor: '#0e0f12',
    title: `NovaNet Server ${APP_VERSION_LABEL}`,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error('[main] preload failed:', p, err);
  });
  void mainWindow.loadFile(rendererIndex);
  mainWindow.webContents.openDevTools({ mode: 'detach' });
  controller.on('status', (status) => {
    mainWindow?.webContents.send('status:change', status);
  });
}

ipcMain.handle('log:open', async () => {
  try { await shell.openPath(logFilePath); return logFilePath; }
  catch (e) { return `failed: ${(e as Error).message}`; }
});
ipcMain.handle('log:path', () => logFilePath);

ipcMain.handle('status:get', () => controller.getStatus());
ipcMain.handle('auth:send-code', async (_e, phone: string, account?: 'server' | 'client') => controller.sendPhoneCode(phone, account ?? 'server'));
ipcMain.handle('auth:resend-code', async (_e, account?: 'server' | 'client') => controller.resendCode(account ?? 'server'));
ipcMain.handle('auth:verify-code', async (_e, code: string, account?: 'server' | 'client') => controller.verifyCode(code, account ?? 'server'));
ipcMain.handle('auth:verify-password', async (_e, pw: string, account?: 'server' | 'client') => controller.verifyPassword(pw, account ?? 'server'));
ipcMain.handle('auth:back-to-phone', (_e, account?: 'server' | 'client') => controller.backToPhone(account ?? 'server'));
ipcMain.handle('auth:back-to-code', (_e, account?: 'server' | 'client') => controller.backToCode(account ?? 'server'));
ipcMain.handle('auth:sign-out', async (_e, account?: 'server' | 'client') => controller.signOut(account ?? 'server'));
ipcMain.handle('server:start', async (_e, password: string) => controller.startServer(password));
ipcMain.handle('server:stop', async () => controller.stopServer());
ipcMain.handle('client:create', async (_e, name: string) => controller.createClient(name));
ipcMain.handle('client:delete', async (_e, id: string) => controller.deleteClient(id));
ipcMain.handle('connection:terminate', async (_e, id: string, reason?: string) => controller.terminateConnection(id, reason));
ipcMain.handle('user:reset', async (_e, peerKey: string) => controller.resetUser(peerKey));
ipcMain.handle('logs:list', async () => controller.listLogs());
ipcMain.handle('logs:get', async (_e, id: string) => controller.getLog(id));

let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[main] shutdown: ${reason}`);
  try {
    await Promise.race([controller.dispose(), new Promise<void>((r) => setTimeout(r, 2000))]);
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

app.whenReady().then(() => { createWindow(); controller.init(); });
app.on('window-all-closed', () => void shutdown('all windows closed'));
app.on('before-quit', () => void shutdown('before-quit'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// IMPORTANT: do NOT shut down on uncaughtException / unhandledRejection. A
// single misbehaving tunnel must not take the whole server down. Log + record
// + keep running. Trip a circuit breaker only if errors come too fast.
const errorBudget = { count: 0, windowStart: Date.now() };
const ERROR_WINDOW_MS = 60_000;
const ERROR_BUDGET_MAX = 25;

function recordProcessError(kind: string, error: unknown): void {
  const now = Date.now();
  if (now - errorBudget.windowStart > ERROR_WINDOW_MS) {
    errorBudget.windowStart = now;
    errorBudget.count = 0;
  }
  errorBudget.count += 1;
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  console.error(`[main] ${kind}:`, message);
  controller.recordProcessError(kind, error).catch((e) => {
    console.warn('[main] recordProcessError failed:', (e as Error).message);
  });
  if (errorBudget.count > ERROR_BUDGET_MAX) {
    console.error(`[main] error budget exceeded (${errorBudget.count} in ${ERROR_WINDOW_MS}ms) — restarting process`);
    void shutdown(`${kind} budget exceeded`);
  }
}

process.on('uncaughtException', (error) => recordProcessError('uncaughtException', error));
process.on('unhandledRejection', (reason) => recordProcessError('unhandledRejection', reason));
