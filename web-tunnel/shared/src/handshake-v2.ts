import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import type { Transport } from './transport.js';
import { SessionCipher } from './handshake.js';

const enc = new TextEncoder();

const CLIENT_HELLO_MAGIC = enc.encode('WT2CH');
const SERVER_HELLO_MAGIC = enc.encode('WT2SH');
const NONCE_BYTES = 16;
const PUB_BYTES = 32;
const SIG_BYTES = 64;
const INFO = enc.encode('web-tunnel session v2');

export interface V2ServerIdentity {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface V2ClientHandshakeResult {
  cipher: SessionCipher;
  serverPublicKey: Uint8Array;
  serverFingerprint: string;
}

/** Optional metadata the client can advertise in its hello (e.g. clientType, clientVersion). */
export interface V2ClientMetadata {
  clientType?: string;
  clientVersion?: string;
  [k: string]: unknown;
}

export interface V2ServerHandshakeResult {
  cipher: SessionCipher;
  /** Decoded optional client metadata, if the client supplied any. */
  clientMetadata: V2ClientMetadata | null;
}

export function createV2ServerIdentity(): V2ServerIdentity {
  const edPrivate = ed25519.utils.randomSecretKey();
  return {
    privateKey: edPrivate,
    publicKey: ed25519.getPublicKey(edPrivate),
  };
}

export function createV2ServerIdentityFromPrivateKey(privateKey: Uint8Array): V2ServerIdentity {
  if (privateKey.byteLength !== 32) throw new Error('v2 server private key must be 32 bytes');
  return {
    privateKey: privateKey.slice(),
    publicKey: ed25519.getPublicKey(privateKey),
  };
}

export async function clientHandshakeV2(
  transport: Transport,
  opts: { metadata?: V2ClientMetadata } = {},
): Promise<V2ClientHandshakeResult> {
  const clientSecret = x25519.utils.randomSecretKey();
  const clientPublic = x25519.getPublicKey(clientSecret);
  const clientNonce = randomBytes(NONCE_BYTES);
  const clientTs = Date.now();
  const clientHello = encodeClientHello(clientPublic, clientNonce, clientTs, opts.metadata);

  return new Promise<V2ClientHandshakeResult>((resolve, reject) => {
    let done = false;
    transport.onMessage((wire) => {
      if (done) return;
      try {
        const hello = decodeServerHello(wire);
        const transcript = concat(
          enc.encode('WT2-SIG'),
          clientHello,
          encodeServerHelloUnsigned(
            hello.serverIdentityPublicKey,
            hello.serverEphemeralPublicKey,
            hello.serverNonce,
            hello.serverTs,
          ),
        );
        const ok = ed25519.verify(hello.signature, transcript, hello.serverIdentityPublicKey);
        if (!ok) throw new Error('v2 server signature verification failed');

        const shared = x25519.getSharedSecret(clientSecret, hello.serverEphemeralPublicKey);
        const key = hkdf(sha256, shared, concat(clientNonce, hello.serverNonce), INFO, 32);
        done = true;
        resolve({
          cipher: SessionCipher.fromKey(key),
          serverPublicKey: hello.serverIdentityPublicKey,
          serverFingerprint: serverFingerprint(hello.serverIdentityPublicKey),
        });
      } catch (e) {
        done = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    transport.onClose((reason) => {
      if (done) return;
      done = true;
      reject(new Error(`transport closed during v2 handshake: ${reason}`));
    });
    void transport.send(clientHello);
  });
}

export async function serverHandshakeV2(
  transport: Transport,
  identity: V2ServerIdentity,
): Promise<V2ServerHandshakeResult> {
  if (identity.privateKey.byteLength !== 32 || identity.publicKey.byteLength !== 32) {
    throw new Error('invalid v2 server identity');
  }
  return new Promise<V2ServerHandshakeResult>((resolve, reject) => {
    let done = false;
    transport.onMessage((wire) => {
      if (done) return;
      try {
        const clientHello = decodeClientHello(wire);
        const serverSecret = x25519.utils.randomSecretKey();
        const serverEphemeralPublicKey = x25519.getPublicKey(serverSecret);
        const serverNonce = randomBytes(NONCE_BYTES);
        const serverTs = Date.now();

        const unsigned = encodeServerHelloUnsigned(
          identity.publicKey,
          serverEphemeralPublicKey,
          serverNonce,
          serverTs,
        );
        const transcript = concat(enc.encode('WT2-SIG'), wire, unsigned);
        const signature = ed25519.sign(transcript, identity.privateKey);
        const serverHello = concat(unsigned, signature);

        void transport.send(serverHello);
        const shared = x25519.getSharedSecret(serverSecret, clientHello.clientPublicKey);
        const key = hkdf(sha256, shared, concat(clientHello.clientNonce, serverNonce), INFO, 32);
        done = true;
        resolve({ cipher: SessionCipher.fromKey(key), clientMetadata: clientHello.metadata });
      } catch (e) {
        done = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    transport.onClose((reason) => {
      if (done) return;
      done = true;
      reject(new Error(`transport closed during v2 handshake: ${reason}`));
    });
  });
}

export function serverFingerprint(serverPublicKey: Uint8Array): string {
  const digest = sha256(serverPublicKey);
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface DecodedClientHello {
  clientPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  metadata: V2ClientMetadata | null;
}

interface DecodedServerHello {
  serverIdentityPublicKey: Uint8Array;
  serverEphemeralPublicKey: Uint8Array;
  serverNonce: Uint8Array;
  serverTs: number;
  signature: Uint8Array;
}

function encodeClientHello(
  clientPublicKey: Uint8Array,
  clientNonce: Uint8Array,
  clientTs: number,
  metadata?: V2ClientMetadata,
): Uint8Array {
  if (clientPublicKey.byteLength !== PUB_BYTES) throw new Error('invalid client public key length');
  if (clientNonce.byteLength !== NONCE_BYTES) throw new Error('invalid client nonce length');
  const baseLen = CLIENT_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES + PUB_BYTES;
  let metaBytes: Uint8Array = new Uint8Array(0);
  if (metadata && Object.keys(metadata).length > 0) {
    metaBytes = enc.encode(JSON.stringify(metadata));
    if (metaBytes.byteLength > 0xffff) throw new Error('v2 client metadata too large');
  }
  const out = new Uint8Array(baseLen + (metaBytes.byteLength > 0 ? 2 + metaBytes.byteLength : 0));
  out.set(CLIENT_HELLO_MAGIC, 0);
  out[CLIENT_HELLO_MAGIC.byteLength] = 2;
  const view = new DataView(out.buffer);
  view.setBigUint64(CLIENT_HELLO_MAGIC.byteLength + 1, BigInt(clientTs), false);
  out.set(clientNonce, CLIENT_HELLO_MAGIC.byteLength + 1 + 8);
  out.set(clientPublicKey, CLIENT_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES);
  if (metaBytes.byteLength > 0) {
    view.setUint16(baseLen, metaBytes.byteLength, false);
    out.set(metaBytes, baseLen + 2);
  }
  return out;
}

function decodeClientHello(wire: Uint8Array): DecodedClientHello {
  const baseLen = CLIENT_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES + PUB_BYTES;
  // Old-format hellos are exactly baseLen bytes; new-format hellos append
  // [2 bytes length][JSON metadata]. Accept either.
  if (wire.byteLength < baseLen) throw new Error('invalid v2 client hello length');
  if (!equalBytes(wire.slice(0, CLIENT_HELLO_MAGIC.byteLength), CLIENT_HELLO_MAGIC)) {
    throw new Error('invalid v2 client hello magic');
  }
  const version = wire[CLIENT_HELLO_MAGIC.byteLength];
  if (version !== 2) throw new Error(`unsupported v2 client hello version: ${version}`);
  const clientNonce = wire.slice(CLIENT_HELLO_MAGIC.byteLength + 1 + 8, CLIENT_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES);
  const clientPublicKey = wire.slice(CLIENT_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES, baseLen);
  let metadata: V2ClientMetadata | null = null;
  if (wire.byteLength > baseLen) {
    if (wire.byteLength < baseLen + 2) throw new Error('invalid v2 client hello metadata length');
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    const metaLen = view.getUint16(baseLen, false);
    if (wire.byteLength !== baseLen + 2 + metaLen) throw new Error('invalid v2 client hello metadata size');
    if (metaLen > 0) {
      const metaBytes = wire.slice(baseLen + 2, baseLen + 2 + metaLen);
      try {
        metadata = JSON.parse(new TextDecoder('utf-8').decode(metaBytes)) as V2ClientMetadata;
      } catch {
        metadata = null;
      }
    }
  }
  return { clientPublicKey, clientNonce, metadata };
}

function encodeServerHelloUnsigned(
  serverIdentityPublicKey: Uint8Array,
  serverEphemeralPublicKey: Uint8Array,
  serverNonce: Uint8Array,
  serverTs: number,
): Uint8Array {
  if (serverIdentityPublicKey.byteLength !== PUB_BYTES) throw new Error('invalid v2 server identity key');
  if (serverEphemeralPublicKey.byteLength !== PUB_BYTES) throw new Error('invalid v2 server ephemeral key');
  if (serverNonce.byteLength !== NONCE_BYTES) throw new Error('invalid v2 server nonce');
  const out = new Uint8Array(SERVER_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES + PUB_BYTES + PUB_BYTES);
  out.set(SERVER_HELLO_MAGIC, 0);
  out[SERVER_HELLO_MAGIC.byteLength] = 2;
  const view = new DataView(out.buffer);
  view.setBigUint64(SERVER_HELLO_MAGIC.byteLength + 1, BigInt(serverTs), false);
  out.set(serverNonce, SERVER_HELLO_MAGIC.byteLength + 1 + 8);
  out.set(serverIdentityPublicKey, SERVER_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES);
  out.set(serverEphemeralPublicKey, SERVER_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES + PUB_BYTES);
  return out;
}

function decodeServerHello(wire: Uint8Array): DecodedServerHello {
  const unsignedLen = SERVER_HELLO_MAGIC.byteLength + 1 + 8 + NONCE_BYTES + PUB_BYTES + PUB_BYTES;
  const expectedLen = unsignedLen + SIG_BYTES;
  if (wire.byteLength !== expectedLen) throw new Error('invalid v2 server hello length');
  if (!equalBytes(wire.slice(0, SERVER_HELLO_MAGIC.byteLength), SERVER_HELLO_MAGIC)) {
    throw new Error('invalid v2 server hello magic');
  }
  const version = wire[SERVER_HELLO_MAGIC.byteLength];
  if (version !== 2) throw new Error(`unsupported v2 server hello version: ${version}`);
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const serverTs = Number(view.getBigUint64(SERVER_HELLO_MAGIC.byteLength + 1, false));
  const offset = SERVER_HELLO_MAGIC.byteLength + 1 + 8;
  const serverNonce = wire.slice(offset, offset + NONCE_BYTES);
  const serverIdentityPublicKey = wire.slice(offset + NONCE_BYTES, offset + NONCE_BYTES + PUB_BYTES);
  const serverEphemeralPublicKey = wire.slice(offset + NONCE_BYTES + PUB_BYTES, offset + NONCE_BYTES + PUB_BYTES + PUB_BYTES);
  const signature = wire.slice(unsignedLen);
  return { serverIdentityPublicKey, serverEphemeralPublicKey, serverNonce, serverTs, signature };
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
