import { describe, expect, it } from 'vitest';
import { buildDeny, buildFrameMessage, buildFrameMessageV2, buildOk, buildReq, parseMagic } from '../src/magic.js';

describe('magic', () => {
  it('classifies plain chat', () => {
    expect(parseMagic('hello friend')).toEqual({ kind: 'chat', text: 'hello friend' });
  });

  it('round-trips REQ', () => {
    const body = new Uint8Array([1, 2, 3, 0xff, 0x00]);
    const parsed = parseMagic(buildReq(body));
    expect(parsed.kind).toBe('req');
    if (parsed.kind === 'req') {
      expect(Array.from(parsed.body)).toEqual([1, 2, 3, 0xff, 0x00]);
    }
  });

  it('round-trips OK', () => {
    const body = new Uint8Array([9, 8, 7, 6, 5]);
    const parsed = parseMagic(buildOk(body));
    expect(parsed.kind).toBe('ok');
    if (parsed.kind === 'ok') {
      expect(Array.from(parsed.body)).toEqual([9, 8, 7, 6, 5]);
    }
  });

  it('carries a DENY reason', () => {
    expect(parseMagic(buildDeny('rate limited'))).toEqual({ kind: 'deny', reason: 'rate limited' });
  });

  it('round-trips a FRAME message', () => {
    const body = new Uint8Array(Array.from({ length: 60 }, (_, i) => i));
    const parsed = parseMagic(buildFrameMessage(body));
    expect(parsed.kind).toBe('frame');
    if (parsed.kind === 'frame') {
      expect(parsed.protocolVersion).toBe(1);
      expect(parsed.sessionTag).toBeNull();
      expect(Array.from(parsed.body)).toEqual(Array.from(body));
    }
  });

  it('round-trips a FRAME message with a session tag', () => {
    const body = new Uint8Array([7, 8, 9]);
    const parsed = parseMagic(buildFrameMessage(body, 'session-123'));
    expect(parsed.kind).toBe('frame');
    if (parsed.kind === 'frame') {
      expect(parsed.protocolVersion).toBe(1);
      expect(parsed.sessionTag).toBe('session-123');
      expect(Array.from(parsed.body)).toEqual([7, 8, 9]);
    }
  });

  it('round-trips a v2 FRAME message', () => {
    const body = new Uint8Array([1, 3, 5, 7, 9]);
    const parsed = parseMagic(buildFrameMessageV2(body, 's-v2'));
    expect(parsed.kind).toBe('frame');
    if (parsed.kind === 'frame') {
      expect(parsed.protocolVersion).toBe(2);
      expect(parsed.sessionTag).toBe('s-v2');
      expect(Array.from(parsed.body)).toEqual(Array.from(body));
    }
  });

  it('uses base64url (no + / =)', () => {
    const body = new Uint8Array([0xfb, 0xff, 0xf0]);
    const wire = buildReq(body);
    expect(wire).not.toMatch(/[+/=]/);
  });
});
