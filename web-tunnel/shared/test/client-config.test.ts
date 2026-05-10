import { describe, expect, it } from 'vitest';
import { decodeClientConfig, encodeClientConfig, type WebTunnelClientConfigV1 } from '../src/index.js';

describe('client config', () => {
  it('round-trips encrypted config payloads', async () => {
    const payload: WebTunnelClientConfigV1 = {
      schema: 1,
      clientId: 'client-1',
      clientName: 'alice laptop',
      createdAt: 123,
      carrier: 'webrtc',
      defaultSocksPort: 1080,
      baleSession: {
        jwt: 'jwt',
        userId: '42',
        userName: 'shared client',
        userAccessHash: '99',
      },
      serverPeer: {
        chatId: 7,
        chatType: 'PRIVATE',
        label: 'server',
      },
      serverUuid: '4f4ae25c-baa7-4416-a4a0-a48d4488d1c4',
      serverFingerprint: 'abc',
    };
    const encoded = await encodeClientConfig(payload);
    expect(encoded.startsWith('wtc1:')).toBe(true);
    await expect(decodeClientConfig(encoded)).resolves.toEqual(payload);
  });

  it('rejects malformed server UUIDs', async () => {
    const payload: WebTunnelClientConfigV1 = {
      schema: 1,
      clientId: 'client-1',
      clientName: 'alice laptop',
      createdAt: 123,
      carrier: 'webrtc',
      defaultSocksPort: 1080,
      baleSession: {
        jwt: 'jwt',
        userId: '42',
        userName: 'shared client',
        userAccessHash: '99',
      },
      serverPeer: {
        chatId: 7,
        chatType: 'PRIVATE',
        label: 'server',
      },
      serverUuid: 'not-a-uuid',
      serverFingerprint: 'abc',
    };

    await expect(encodeClientConfig(payload)).rejects.toThrow('invalid server uuid');
  });
});
