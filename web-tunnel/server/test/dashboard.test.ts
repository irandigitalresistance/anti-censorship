import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { TunnelManager } from '../src/dashboard/manager.js';
import { startDashboard } from '../src/dashboard/server.js';

async function startServer(manager: TunnelManager) {
  const handles = startDashboard({ manager, port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => {
    if (handles.httpServer.listening) r();
    else handles.httpServer.once('listening', () => r());
  });
  const port = (handles.httpServer.address() as AddressInfo).port;
  return { handles, port };
}

function openWsAndCollect(port: number, ms: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
    const events: unknown[] = [];
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(events);
    }, ms);
    ws.on('message', (data) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
      try {
        events.push(JSON.parse(buf.toString('utf8')));
      } catch (e) {
        /* ignore */
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('dashboard', () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it('serves the static dashboard HTML', async () => {
    const manager = new TunnelManager(50);
    manager.start();
    const { handles, port } = await startServer(manager);
    cleanup.push(async () => {
      manager.stop();
      await handles.close();
    });
    const resp = await fetch(`http://127.0.0.1:${port}/`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain('web-tunnel v0.4.0-beta dashboard');
    expect(body).toContain('Active tunnels');
  });

  it('serves /api/tunnels reflecting manager state', async () => {
    const manager = new TunnelManager(50);
    manager.start();
    const { handles, port } = await startServer(manager);
    cleanup.push(async () => {
      manager.stop();
      await handles.close();
    });

    const empty = (await (await fetch(`http://127.0.0.1:${port}/api/tunnels`)).json()) as { tunnels: unknown[] };
    expect(empty.tunnels).toEqual([]);

    const t = manager.openTunnel('ws://test:1');
    const populated = (await (await fetch(`http://127.0.0.1:${port}/api/tunnels`)).json()) as {
      tunnels: Array<{ id: string; label: string }>;
    };
    expect(populated.tunnels).toHaveLength(1);
    expect(populated.tunnels[0]!.label).toBe('ws://test:1');
    expect(populated.tunnels[0]!.id).toBe(t.id);

    t.close('done');
    const clearedRaw = (await (await fetch(`http://127.0.0.1:${port}/api/tunnels`)).json()) as { tunnels: unknown[] };
    expect(clearedRaw.tunnels).toEqual([]);
  });

  it('pushes tunnel + metrics events to WS subscribers', async () => {
    const manager = new TunnelManager(50); // tick every 50ms for fast test
    manager.start();
    const { handles, port } = await startServer(manager);
    cleanup.push(async () => {
      manager.stop();
      await handles.close();
    });

    // Fire off a tunnel + some byte activity while the WS is collecting.
    const collect = openWsAndCollect(port, 400);
    // Let the WS connect
    await new Promise((r) => setTimeout(r, 50));
    const tunnel = manager.openTunnel('ws://demo');
    tunnel.handle.openStream(1, { kind: 'domain', host: 'x', port: 80 });
    tunnel.handle.addBytes(1, 'up', 1_000);
    tunnel.handle.addBytes(1, 'down', 5_000);
    // Let the tick fire at least once
    await new Promise((r) => setTimeout(r, 120));
    tunnel.handle.addBytes(1, 'down', 2_000);
    await new Promise((r) => setTimeout(r, 120));
    tunnel.close('done');

    const events = (await collect) as Array<Record<string, unknown>>;
    const types = events.map((e) => e['type']);
    expect(types[0]).toBe('snapshot');
    expect(types).toContain('tunnel-opened');
    expect(types).toContain('stream-opened');
    expect(types.filter((t) => t === 'metrics').length).toBeGreaterThan(0);
    expect(types).toContain('tunnel-closed');

    const metricsEvent = events.find((e) => e['type'] === 'metrics') as
      | { perTunnel: Record<string, { bytesUpDelta: number; bytesDownDelta: number }> }
      | undefined;
    expect(metricsEvent).toBeDefined();
    const perTunnel = Object.values(metricsEvent!.perTunnel)[0]!;
    expect(perTunnel.bytesUpDelta + perTunnel.bytesDownDelta).toBeGreaterThan(0);
  });

  it('pushes tunnel metadata updates to WS subscribers', async () => {
    const manager = new TunnelManager(50);
    manager.start();
    const { handles, port } = await startServer(manager);
    cleanup.push(async () => {
      manager.stop();
      await handles.close();
    });

    const collect = openWsAndCollect(port, 300);
    await new Promise((r) => setTimeout(r, 50));

    const tunnel = manager.openTunnel('webrtc:PRIVATE:1', {
      carrier: 'webrtc',
      peer: { chatId: 1, chatType: 'PRIVATE', name: null, username: null },
    });
    await new Promise((r) => setTimeout(r, 50));
    manager.updateTunnel(tunnel.id, {
      peer: { chatId: 1, chatType: 'PRIVATE', name: 'Alice', username: 'alice' },
    });

    const events = (await collect) as Array<Record<string, any>>;
    const updated = events.find((event) => event.type === 'tunnel-updated');
    expect(updated).toBeDefined();
    const updatedTunnel = (updated as { tunnel: { peer: { name: string; username: string } } }).tunnel;
    expect(updatedTunnel.peer.name).toBe('Alice');
    expect(updatedTunnel.peer.username).toBe('alice');
  });
});
