import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import type { MetricsTick, TunnelManager, TunnelSnapshot } from './manager.js';
import type { ClientLogStore } from './log-store.js';
import type { CrashStore, CrashReportInput } from './crash-store.js';

/**
 * Resolve the directory holding this file. Works in both ESM (vitest tests,
 * standalone Node) and the CJS bundle that electron-builder ships, which
 * doesn't have `import.meta` defined.
 */
function moduleDir(): string {
  const meta = (typeof import.meta !== 'undefined' ? import.meta : null) as { url?: string } | null;
  if (meta?.url) return path.dirname(fileURLToPath(meta.url));
  // CJS path: __dirname is the global provided by Node's CJS loader.
  return typeof __dirname !== 'undefined' ? __dirname : process.cwd();
}

export interface DashboardOptions {
  manager: TunnelManager;
  port: number;
  host?: string;
  logStore?: ClientLogStore;
  crashStore?: CrashStore;
  /**
   * If provided, the dashboard exposes POST /api/client-logs and
   * POST /api/crashes endpoints that authenticate via an HMAC-SHA256 of the
   * raw body using this key. Lets clients upload diagnostics without
   * needing an active tunnel.
   */
  uploadHmacKey?: Uint8Array;
}

export interface DashboardHandles {
  httpServer: http.Server;
  close: () => Promise<void>;
}

export function startDashboard(opts: DashboardOptions): DashboardHandles {
  const { manager, port, host = '127.0.0.1', logStore, crashStore, uploadHmacKey } = opts;
  const app = express();
  // Capture raw body so we can HMAC-verify uploads. JSON parser still runs.
  app.use(express.json({
    limit: '6mb',
    verify: (req, _res, buf) => {
      (req as http.IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }));

  function verifyUploadAuth(req: express.Request): { ok: true } | { ok: false; reason: string } {
    if (!uploadHmacKey) return { ok: false, reason: 'uploads disabled (no HMAC key)' };
    const header = req.header('authorization') ?? '';
    const expectedPrefix = 'Bearer ';
    if (!header.startsWith(expectedPrefix)) return { ok: false, reason: 'missing bearer' };
    const supplied = header.slice(expectedPrefix.length).trim();
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const mac = crypto.createHmac('sha256', Buffer.from(uploadHmacKey)).update(raw).digest('hex');
    try {
      const a = Buffer.from(mac, 'hex');
      const b = Buffer.from(supplied, 'hex');
      if (a.length !== b.length) return { ok: false, reason: 'bad signature length' };
      if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
    } catch {
      return { ok: false, reason: 'bad signature encoding' };
    }
    return { ok: true };
  }
  const here = moduleDir();
  app.use(express.static(path.join(here, 'web')));
  app.get('/api/tunnels', (_req, res) => {
    res.json({ tunnels: manager.snapshot(), lifetime: manager.getLifetime() });
  });
  app.get('/api/totals', (_req, res) => {
    res.json({ lifetime: manager.getLifetime() });
  });
  app.post('/api/tunnels/:id/terminate', async (req, res) => {
    const id = req.params.id;
    const reasonRaw = typeof req.body?.reason === 'string' ? req.body.reason : 'terminated by server';
    const reason = reasonRaw.slice(0, 256);
    const ok = await manager.terminateTunnel(id, reason);
    if (!ok) {
      res.status(404).json({ ok: false, error: 'tunnel not found or not terminable' });
      return;
    }
    res.json({ ok: true });
  });
  app.get('/api/logs', (_req, res) => {
    res.json({ logs: logStore?.list() ?? [] });
  });
  app.get('/api/logs/:id', (req, res) => {
    const log = logStore?.get(req.params.id) ?? null;
    if (!log) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ log });
  });
  app.get('/api/logs/:id/download', (req, res) => {
    const log = logStore?.get(req.params.id) ?? null;
    if (!log) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    res.setHeader('Content-Type', log.contentType || 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFileName(log.fileName)}"`);
    res.send(log.body);
  });

  // ---- Out-of-band upload endpoints (no tunnel required). ----
  app.post('/api/client-logs', (req, res) => {
    if (!logStore) { res.status(503).json({ error: 'log store disabled' }); return; }
    const auth = verifyUploadAuth(req);
    if (!auth.ok) { res.status(401).json({ error: auth.reason }); return; }
    const body = req.body as Partial<{
      reportId: string; source: string; sentAt: number;
      fileName: string; contentType: string; body: string;
      meta: Record<string, string | number | null>;
    }>;
    if (typeof body?.body !== 'string' || typeof body?.source !== 'string') {
      res.status(400).json({ error: 'missing source/body' });
      return;
    }
    const summary = logStore.add({
      reportId: body.reportId ?? '',
      source: body.source,
      sentAt: body.sentAt ?? Date.now(),
      fileName: body.fileName ?? 'client-log.txt',
      contentType: body.contentType ?? 'text/plain; charset=utf-8',
      body: body.body,
      meta: body.meta ?? {},
    }, null);
    res.json({ ok: true, id: summary.id });
  });

  app.get('/api/crashes', (_req, res) => {
    res.json({ crashes: crashStore?.list() ?? [] });
  });
  app.post('/api/crashes', (req, res) => {
    if (!crashStore) { res.status(503).json({ error: 'crash store disabled' }); return; }
    const auth = verifyUploadAuth(req);
    if (!auth.ok) { res.status(401).json({ error: auth.reason }); return; }
    const body = req.body as Partial<CrashReportInput>;
    if (typeof body?.message !== 'string' || typeof body?.source !== 'string') {
      res.status(400).json({ error: 'missing source/message' });
      return;
    }
    const record = crashStore.add({
      reportId: body.reportId,
      source: body.source,
      appVersion: body.appVersion ?? 'unknown',
      occurredAt: body.occurredAt ?? Date.now(),
      kind: body.kind ?? 'unknown',
      message: body.message,
      stack: body.stack ?? '',
      meta: body.meta ?? null,
    });
    res.json({ ok: true, id: record.id });
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/events' });

  const broadcast = (obj: Record<string, unknown>): void => {
    const msg = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  };

  const onOpened = (t: TunnelSnapshot): void => broadcast({ type: 'tunnel-opened', tunnel: t });
  const onUpdated = (t: TunnelSnapshot): void => broadcast({ type: 'tunnel-updated', tunnel: t });
  const onClosed = (t: TunnelSnapshot): void => broadcast({ type: 'tunnel-closed', tunnel: t });
  const onStreamOpened = (e: unknown): void => broadcast({ type: 'stream-opened', ...(e as object) });
  const onStreamClosed = (e: unknown): void => broadcast({ type: 'stream-closed', ...(e as object) });
  const onMetrics = (tick: MetricsTick): void => broadcast({ type: 'metrics', ...tick });

  manager.on('tunnel-opened', onOpened);
  manager.on('tunnel-updated', onUpdated);
  manager.on('tunnel-closed', onClosed);
  manager.on('stream-opened', onStreamOpened);
  manager.on('stream-closed', onStreamClosed);
  manager.on('metrics-tick', onMetrics);

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'snapshot',
      tunnels: manager.snapshot(),
      lifetime: manager.getLifetime(),
      now: Date.now(),
    }));
  });

  // Don't let a stray listen error (port already in use, perms) crash the
  // whole process. The caller can probe for it via httpServer.listening.
  httpServer.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn(`[dashboard] HTTP server error: ${(err as Error).message}`);
  });
  httpServer.listen(port, host);

  return {
    httpServer,
    close: async () => {
      manager.off('tunnel-opened', onOpened);
      manager.off('tunnel-updated', onUpdated);
      manager.off('tunnel-closed', onClosed);
      manager.off('stream-opened', onStreamOpened);
      manager.off('stream-closed', onStreamClosed);
      manager.off('metrics-tick', onMetrics);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

function sanitizeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'client-log.txt';
}
