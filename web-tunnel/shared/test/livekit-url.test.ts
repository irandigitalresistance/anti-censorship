import { describe, expect, it } from 'vitest';
import { buildLiveKitUrl, type StartCallResult } from '../src/bale/messages.js';
import { extractLivekitConnectArgs } from '../src/bale/meet-factory.js';

describe('livekit url handling', () => {
  const sample: StartCallResult = {
    callId: 1n,
    jwt: 'jwt-token',
    roomUuid: 'room-1',
    baseUrl: 'wss://meet-gwe.ble.ir',
    startedAtMs: 0n,
    serverAuthTs: 0n,
    peer: { type: 1, id: 2n },
    state: 1,
  };

  it('keeps Bale baseUrl at the server root', () => {
    const url = buildLiveKitUrl(sample);
    expect(url.startsWith('wss://meet-gwe.ble.ir?')).toBe(true);
    expect(url).not.toContain('/rtc?');
  });

  it('extracts server root and token from current bundle urls', () => {
    const args = extractLivekitConnectArgs(buildLiveKitUrl(sample));
    expect(args).toEqual({
      serverUrl: 'wss://meet-gwe.ble.ir',
      token: 'jwt-token',
    });
  });

  it('strips legacy /rtc suffixes before handing url to the sdk', () => {
    expect(extractLivekitConnectArgs('wss://meet-gwe.ble.ir/rtc?access_token=abc')).toEqual({
      serverUrl: 'wss://meet-gwe.ble.ir',
      token: 'abc',
    });
    expect(extractLivekitConnectArgs('wss://meet-gwe.ble.ir/prefix/rtc/v1?access_token=abc')).toEqual({
      serverUrl: 'wss://meet-gwe.ble.ir/prefix',
      token: 'abc',
    });
  });
});
