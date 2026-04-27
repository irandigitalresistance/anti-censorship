import { describe, expect, it } from 'vitest';
import { decodeOpen, encodeOpen } from '../src/open.js';

describe('open', () => {
  it('round-trips a domain address', () => {
    const a = { kind: 'domain', host: 'example.com', port: 443 } as const;
    expect(decodeOpen(encodeOpen(a))).toEqual(a);
  });

  it('round-trips an ipv4 address', () => {
    const a = { kind: 'ipv4', host: '93.184.216.34', port: 80 } as const;
    expect(decodeOpen(encodeOpen(a))).toEqual(a);
  });

  it('round-trips an ipv6 address', () => {
    const a = { kind: 'ipv6', host: '2606:2800:220:1:248:1893:25c8:1946', port: 443 } as const;
    expect(decodeOpen(encodeOpen(a))).toEqual(a);
  });

  it('handles ipv6 shorthand on parse', () => {
    const a = { kind: 'ipv6', host: '::1', port: 22 } as const;
    const round = decodeOpen(encodeOpen(a));
    expect(round.port).toBe(22);
    expect(round.kind).toBe('ipv6');
    expect((round as { host: string }).host).toBe('0:0:0:0:0:0:0:1');
  });

  it('rejects bad port', () => {
    expect(() => encodeOpen({ kind: 'domain', host: 'x', port: -1 })).toThrow(/u16/);
    expect(() => encodeOpen({ kind: 'domain', host: 'x', port: 70000 })).toThrow(/u16/);
  });

  it('rejects bad ipv4', () => {
    expect(() => encodeOpen({ kind: 'ipv4', host: '1.2.3', port: 80 })).toThrow(/ipv4/);
    expect(() => encodeOpen({ kind: 'ipv4', host: '1.2.3.256', port: 80 })).toThrow(/ipv4/);
  });
});
