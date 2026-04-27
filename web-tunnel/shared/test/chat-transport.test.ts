import { describe, expect, it } from 'vitest';
import { SessionCipher } from '../src/handshake.js';
import { TunnelMux } from '../src/mux.js';
import { MockBalBus, MockSidecar } from '../src/mock-sidecar.js';
import { makeChatTransport } from '../src/chat-transport.js';

describe('ChatTransport over MockBalBus', () => {
  it('delivers frames between two sidecars via __WT_FRAME__ envelopes', async () => {
    const bus = new MockBalBus();
    const server = new MockSidecar(bus, { id: 100, name: 'server-bot' });
    const client = new MockSidecar(bus, { id: 200, name: 'client-user' });

    const serverT = makeChatTransport({ sidecar: server, peer: { chatId: 200, chatType: 'PRIVATE' } });
    const clientT = makeChatTransport({ sidecar: client, peer: { chatId: 100, chatType: 'PRIVATE' } });

    // Wire up a simple echo on the server side using TunnelMux
    const psk = new Uint8Array(32);
    const cipher = SessionCipher.derive(psk, new Uint8Array(16), new Uint8Array(16));
    const sMux = new TunnelMux({ transport: serverT, cipher, role: 'server' });
    const cMux = new TunnelMux({ transport: clientT, cipher, role: 'client' });

    const sawStream = new Promise<void>((resolve) => {
      sMux.onStream((s) => {
        s.onData((d) => s.write(new Uint8Array([...d, 0x2e])));
        resolve();
      });
    });

    const stream = cMux.openStream({ kind: 'domain', host: 'echo.test', port: 80 });
    const got = new Promise<Uint8Array>((resolve) => stream.onData((d) => resolve(d)));
    stream.write(new TextEncoder().encode('hello world'));

    await sawStream;
    const echoed = await got;
    expect(new TextDecoder().decode(echoed)).toBe('hello world.');
  });

  it('routes non-frame chat-audit text to onChat, not to onMessage', async () => {
    const bus = new MockBalBus();
    const a = new MockSidecar(bus, { id: 1, name: 'a' });
    const b = new MockSidecar(bus, { id: 2, name: 'b' });

    const auditSeen: string[] = [];
    const byteSeen: Uint8Array[] = [];
    const aT = makeChatTransport({
      sidecar: a,
      peer: { chatId: 2, chatType: 'PRIVATE' },
      onChat: (t) => auditSeen.push(t),
    });
    aT.onMessage((b) => byteSeen.push(b));

    await b.sendMessage({ chatId: 1, chatType: 'PRIVATE' }, 'just a regular human message');
    await new Promise<void>((r) => queueMicrotask(() => r()));
    await new Promise<void>((r) => setTimeout(r, 5));

    expect(auditSeen).toEqual(['just a regular human message']);
    expect(byteSeen).toEqual([]);
  });

  it('filters messages not matching the configured peer', async () => {
    const bus = new MockBalBus();
    const a = new MockSidecar(bus, { id: 1, name: 'a' });
    const b = new MockSidecar(bus, { id: 2, name: 'b' });
    const c = new MockSidecar(bus, { id: 3, name: 'c' });

    const audits: string[] = [];
    const aT = makeChatTransport({
      sidecar: a,
      peer: { chatId: 2, chatType: 'PRIVATE' },
      onChat: (t) => audits.push(t),
    });
    // Force the transport to exist
    aT.onMessage(() => undefined);

    await b.sendMessage({ chatId: 1, chatType: 'PRIVATE' }, 'from b');
    await c.sendMessage({ chatId: 1, chatType: 'PRIVATE' }, 'from c');
    await new Promise<void>((r) => setTimeout(r, 5));

    expect(audits).toEqual(['from b']);
  });
});
