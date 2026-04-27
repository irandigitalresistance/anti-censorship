import { describe, expect, it } from 'vitest';
import { SessionCipher } from '../src/handshake.js';
import { TunnelMux } from '../src/mux.js';
import { MockLivekitBus, MockLivekitRoom } from '../src/mock-livekit.js';
import { makeLivekitTransport } from '../src/livekit-transport.js';

describe('LivekitTransport over MockLivekitBus', () => {
  it('delivers bytes between two participants', async () => {
    const bus = new MockLivekitBus();
    const serverRoom = new MockLivekitRoom(bus, 'server');
    const clientRoom = new MockLivekitRoom(bus, 'client');

    const serverT = makeLivekitTransport({ room: serverRoom, peerIdentity: 'client' });
    const clientT = makeLivekitTransport({ room: clientRoom, peerIdentity: 'server' });

    const psk = new Uint8Array(32);
    const cipher = SessionCipher.derive(psk, new Uint8Array(16), new Uint8Array(16));
    const sMux = new TunnelMux({ transport: serverT, cipher, role: 'server' });
    const cMux = new TunnelMux({ transport: clientT, cipher, role: 'client' });

    sMux.onStream((s) => {
      s.onData((d) => s.write(new Uint8Array([...d, 33])));
    });

    const stream = cMux.openStream({ kind: 'domain', host: 'lk.test', port: 443 });
    const got = new Promise<Uint8Array>((resolve) => stream.onData((d) => resolve(d)));
    stream.write(new TextEncoder().encode('howdy'));
    const echoed = await got;
    expect(new TextDecoder().decode(echoed)).toBe('howdy!');
  });

  it('filters data from participants other than the configured peer', async () => {
    const bus = new MockLivekitBus();
    const a = new MockLivekitRoom(bus, 'a');
    const b = new MockLivekitRoom(bus, 'b');
    const c = new MockLivekitRoom(bus, 'c');

    const aT = makeLivekitTransport({ room: a, peerIdentity: 'b' });
    const received: Uint8Array[] = [];
    aT.onMessage((bytes) => received.push(bytes));

    await b.publishData(new Uint8Array([1, 2, 3]), { destinationIdentities: ['a'] });
    await c.publishData(new Uint8Array([9, 9, 9]), { destinationIdentities: ['a'] });
    await new Promise<void>((r) => queueMicrotask(() => r()));
    await new Promise<void>((r) => setTimeout(r, 5));

    expect(received.length).toBe(1);
    expect(Array.from(received[0]!)).toEqual([1, 2, 3]);
  });

  it('surfaces room disconnect as transport close', async () => {
    const bus = new MockLivekitBus();
    const a = new MockLivekitRoom(bus, 'a');
    const b = new MockLivekitRoom(bus, 'b');
    const aT = makeLivekitTransport({ room: a, peerIdentity: 'b' });
    let closedReason: string | null = null;
    aT.onClose((r) => {
      closedReason = r;
    });
    await b.disconnect('b leaving');
    bus.disconnectAll('bus tore down');
    expect(closedReason).toBe('bus tore down');
  });

  it('can learn opaque peer identities dynamically', async () => {
    const bus = new MockLivekitBus();
    const serverRoom = new MockLivekitRoom(bus, 'bale-server-opaque-id');
    const clientRoom = new MockLivekitRoom(bus, 'bale-client-opaque-id');

    const serverT = makeLivekitTransport({ room: serverRoom });
    const clientT = makeLivekitTransport({ room: clientRoom });

    const psk = new Uint8Array(32);
    const cipher = SessionCipher.derive(psk, new Uint8Array(16), new Uint8Array(16));
    const sMux = new TunnelMux({ transport: serverT, cipher, role: 'server' });
    const cMux = new TunnelMux({ transport: clientT, cipher, role: 'client' });

    sMux.onStream((s) => {
      s.onData((d) => s.write(new Uint8Array([...d, 63])));
    });

    const stream = cMux.openStream({ kind: 'domain', host: 'lk.test', port: 443 });
    const got = new Promise<Uint8Array>((resolve) => stream.onData((d) => resolve(d)));
    stream.write(new TextEncoder().encode('opaque'));
    const echoed = await got;
    expect(new TextDecoder().decode(echoed)).toBe('opaque?');
  });
});
