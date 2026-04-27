import { describe, expect, it } from 'vitest';
import {
  SessionCipher,
  deriveKeyFromPassword,
  makeHandshakeOk,
  makeHandshakeReq,
  verifyHandshakeOk,
  verifyHandshakeReq,
} from '../src/handshake.js';

describe('handshake', () => {
  it('derives a stable key from a password and salt', () => {
    const salt = new Uint8Array(16);
    const k1 = deriveKeyFromPassword('hunter2', salt);
    const k2 = deriveKeyFromPassword('hunter2', salt);
    expect(Array.from(k1)).toEqual(Array.from(k2));
    expect(k1.byteLength).toBe(32);
  });

  it('completes a three-step handshake', () => {
    const psk = deriveKeyFromPassword('correct horse battery staple', new Uint8Array(16));

    // Client → REQ
    const { wire: reqWire, clientNonce } = makeHandshakeReq(psk);
    // Server verifies REQ
    const req = verifyHandshakeReq(reqWire, psk);
    expect(Array.from(req.clientNonce)).toEqual(Array.from(clientNonce));
    // Server → OK
    const { wire: okWire, serverNonce } = makeHandshakeOk(psk, req.clientNonce);
    // Client verifies OK
    const ok = verifyHandshakeOk(okWire, psk, clientNonce);
    expect(Array.from(ok.serverNonce)).toEqual(Array.from(serverNonce));

    // Both derive the same session key
    const clientSess = SessionCipher.derive(psk, clientNonce, ok.serverNonce);
    const serverSess = SessionCipher.derive(psk, req.clientNonce, serverNonce);

    const plain = new TextEncoder().encode('the quick brown fox');
    const ct = clientSess.encrypt(plain);
    const pt = serverSess.decrypt(ct);
    expect(new TextDecoder().decode(pt)).toBe('the quick brown fox');
  });

  it('rejects a tampered REQ', () => {
    const psk = new Uint8Array(32);
    const { wire } = makeHandshakeReq(psk);
    const last = wire.byteLength - 1;
    wire[last] = (wire[last] ?? 0) ^ 0x01;
    expect(() => verifyHandshakeReq(wire, psk)).toThrow(/MAC/);
  });

  it('rejects an OK bound to a different client nonce', () => {
    const psk = new Uint8Array(32);
    const { wire: reqWire, clientNonce } = makeHandshakeReq(psk);
    const req = verifyHandshakeReq(reqWire, psk);
    const { wire: okWire } = makeHandshakeOk(psk, req.clientNonce);
    const bogusClientNonce = new Uint8Array(clientNonce.byteLength);
    bogusClientNonce.fill(0x11);
    expect(() => verifyHandshakeOk(okWire, psk, bogusClientNonce)).toThrow(/MAC/);
  });

  it('AEAD rejects ciphertext encrypted under a different PSK', () => {
    const psk1 = deriveKeyFromPassword('pw1', new Uint8Array(16));
    const psk2 = deriveKeyFromPassword('pw2', new Uint8Array(16));
    const { wire: reqWire, clientNonce } = makeHandshakeReq(psk1);
    const req = verifyHandshakeReq(reqWire, psk1);
    const { serverNonce } = makeHandshakeOk(psk1, req.clientNonce);
    const s1 = SessionCipher.derive(psk1, clientNonce, serverNonce);
    const s2 = SessionCipher.derive(psk2, clientNonce, serverNonce);
    const ct = s1.encrypt(new TextEncoder().encode('secret'));
    expect(() => s2.decrypt(ct)).toThrow();
  });

  it('AEAD supports AAD binding', () => {
    const psk = new Uint8Array(32);
    const sess = SessionCipher.derive(psk, new Uint8Array(16), new Uint8Array(16));
    const pt = new TextEncoder().encode('hi');
    const aad = new TextEncoder().encode('channel:A');
    const ct = sess.encrypt(pt, aad);
    expect(new TextDecoder().decode(sess.decrypt(ct, aad))).toBe('hi');
    const wrongAad = new TextEncoder().encode('channel:B');
    expect(() => sess.decrypt(ct, wrongAad)).toThrow();
  });
});
