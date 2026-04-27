import http from 'node:http';
import { WebSocketServer } from 'ws';
import { deriveKeyFromPassword, PSK_SALT_INFO } from '@webtunnel/shared';
import { wrapServerWebSocket } from './transports/ws-server.js';
import { runServerTunnel } from './tunnel.js';
import { TunnelManager } from './dashboard/manager.js';
import { startDashboard } from './dashboard/server.js';

const PORT = Number(process.env.PORT ?? 4401);
const HOST = process.env.HOST ?? '127.0.0.1';
const DASHBOARD_PORT = Number(process.env.WT_DASHBOARD_PORT ?? 4402);
const PASSWORD = process.env.WT_PASSWORD ?? 'loopback-dev-password';
const psk = deriveKeyFromPassword(PASSWORD, new TextEncoder().encode(PSK_SALT_INFO));

const manager = new TunnelManager();
manager.start();
startDashboard({ manager, port: DASHBOARD_PORT });
console.log(`[dashboard] http://127.0.0.1:${DASHBOARD_PORT}/`);

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('web-tunnel server (loopback transport)\n');
});

const wss = new WebSocketServer({ server: httpServer, path: '/tunnel' });
wss.on('connection', (ws, req) => {
  const label = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  const { close, handle } = manager.openTunnel(`ws://${label}`, {
    carrier: 'ws',
  });
  console.log(`[tunnel] client ${label} connected`);
  // Sandbox the per-tunnel work in its own try/catch so a bad client never
  // takes down the whole connection handler.
  void (async () => {
    try {
      const transport = wrapServerWebSocket(ws);
      const mux = await runServerTunnel(transport, psk, { handle });
      mux.onClose((reason) => {
        try {
          console.log(`[tunnel] ${label} closed: ${reason}`);
          close(reason);
        } catch (e) {
          console.warn(`[tunnel] ${label} close handler failed:`, (e as Error).message);
        }
      });
    } catch (e) {
      console.warn(`[tunnel] ${label} handshake failed: ${(e as Error).message}`);
      try { close(`handshake failed: ${(e as Error).message}`); } catch { /* ignore */ }
      try { ws.close(1008, 'handshake failed'); } catch { /* ignore */ }
    }
  })();
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[server] listening on ws://${HOST}:${PORT}/tunnel`);
});

// Process-level error handlers — log, do NOT exit. A single bad client should
// not be able to crash the whole node server. The Electron wrapper has its own
// error budget; in the standalone CLI server, we just keep going.
process.on('uncaughtException', (error) => {
  console.error('[server] uncaughtException:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
