import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { scrypt } from '@noble/hashes/scrypt';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';

export const PSK_SALT_INFO = 'web-tunnel v0 psk derivation';

const NONCE_BYTES = 24;
const KEY_BYTES = 32;
const MAC_BYTES = 32;
const SESSION_NONCE_BYTES = 16;

const enc = new TextEncoder();

export function deriveKeyFromPassword(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(enc.encode(password), salt, { N: 1 << 15, r: 8, p: 1, dkLen: KEY_BYTES });
}

export interface HandshakeReq {
  clientNonce: Uint8Array;
  mac: Uint8Array;
}
export interface HandshakeOk {
  serverNonce: Uint8Array;
  mac: Uint8Array;
}

export function makeHandshakeReq(psk: Uint8Array): { wire: Uint8Array; clientNonce: Uint8Array } {
  assertKey(psk);
  const clientNonce = randomBytes(SESSION_NONCE_BYTES);
  const mac = hmac(sha256, psk, concat(enc.encode('WT-REQ'), clientNonce));
  return { wire: concat(clientNonce, mac), clientNonce };
}

export function verifyHandshakeReq(wire: Uint8Array, psk: Uint8Array): HandshakeReq {
  assertKey(psk);
  if (wire.byteLength !== SESSION_NONCE_BYTES + MAC_BYTES) throw new Error('bad REQ length');
  const clientNonce = wire.slice(0, SESSION_NONCE_BYTES);
  const mac = wire.slice(SESSION_NONCE_BYTES);
  const expected = hmac(sha256, psk, concat(enc.encode('WT-REQ'), clientNonce));
  if (!ctEqual(mac, expected)) throw new Error('REQ MAC mismatch');
  return { clientNonce, mac };
}

export function makeHandshakeOk(psk: Uint8Array, clientNonce: Uint8Array): { wire: Uint8Array; serverNonce: Uint8Array } {
  assertKey(psk);
  if (clientNonce.byteLength !== SESSION_NONCE_BYTES) throw new Error('bad client nonce length');
  const serverNonce = randomBytes(SESSION_NONCE_BYTES);
  const mac = hmac(sha256, psk, concat(enc.encode('WT-OK'), clientNonce, serverNonce));
  return { wire: concat(serverNonce, mac), serverNonce };
}

export function verifyHandshakeOk(wire: Uint8Array, psk: Uint8Array, clientNonce: Uint8Array): HandshakeOk {
  assertKey(psk);
  if (wire.byteLength !== SESSION_NONCE_BYTES + MAC_BYTES) throw new Error('bad OK length');
  const serverNonce = wire.slice(0, SESSION_NONCE_BYTES);
  const mac = wire.slice(SESSION_NONCE_BYTES);
  const expected = hmac(sha256, psk, concat(enc.encode('WT-OK'), clientNonce, serverNonce));
  if (!ctEqual(mac, expected)) throw new Error('OK MAC mismatch');
  return { serverNonce, mac };
}

export class SessionCipher {
  private readonly key: Uint8Array;

  private constructor(key: Uint8Array) {
    this.key = key;
  }

  static fromKey(key: Uint8Array): SessionCipher {
    assertKey(key);
    return new SessionCipher(key.slice());
  }

  static derive(psk: Uint8Array, clientNonce: Uint8Array, serverNonce: Uint8Array): SessionCipher {
    const ikm = concat(psk, clientNonce, serverNonce);
    const key = hkdf(sha256, ikm, undefined, enc.encode('web-tunnel session v0'), KEY_BYTES);
    return SessionCipher.fromKey(key);
  }

  encrypt(plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
    const nonce = randomBytes(NONCE_BYTES);
    const ct = xchacha20poly1305(this.key, nonce, aad).encrypt(plaintext);
    return concat(nonce, ct);
  }

  decrypt(wire: Uint8Array, aad?: Uint8Array): Uint8Array {
    if (wire.byteLength < NONCE_BYTES + 16) throw new Error('ciphertext too short');
    const nonce = wire.slice(0, NONCE_BYTES);
    const ct = wire.slice(NONCE_BYTES);
    return xchacha20poly1305(this.key, nonce, aad).decrypt(ct);
  }
}

function assertKey(k: Uint8Array): void {
  if (k.byteLength !== KEY_BYTES) throw new Error(`key must be ${KEY_BYTES} bytes, got ${k.byteLength}`);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
