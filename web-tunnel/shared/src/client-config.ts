export const CLIENT_CONFIG_PREFIX = 'wtc1:';

const enc = new TextEncoder();
const dec = new TextDecoder();
const CONFIG_KEY_LABEL = 'web-tunnel encrypted client config v1';
const NONCE_BYTES = 12;

export interface ClientConfigBaleSession {
  jwt: string;
  userId: string;
  userName: string | null;
  userAccessHash: string;
}

export interface ClientConfigServerPeer {
  chatId: number;
  chatType: 'PRIVATE' | 'GROUP';
  label: string;
}

export interface WebTunnelClientConfigV1 {
  schema: 1;
  clientId: string;
  clientName: string;
  createdAt: number;
  carrier: 'webrtc';
  defaultSocksPort: number;
  baleSession: ClientConfigBaleSession;
  serverPeer: ClientConfigServerPeer;
  serverUuid: string;
  serverFingerprint: string | null;
}

export async function encodeClientConfig(payload: WebTunnelClientConfigV1): Promise<string> {
  validatePayload(payload);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plain = enc.encode(JSON.stringify(payload));
  const key = await configKey();
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const packed = new Uint8Array(nonce.byteLength + encrypted.byteLength);
  packed.set(nonce, 0);
  packed.set(encrypted, nonce.byteLength);
  return CLIENT_CONFIG_PREFIX + base64UrlEncode(packed);
}

export async function decodeClientConfig(input: string): Promise<WebTunnelClientConfigV1> {
  const trimmed = input.trim();
  if (!trimmed.startsWith(CLIENT_CONFIG_PREFIX)) {
    throw new Error('client config must start with wtc1:');
  }
  const packed = base64UrlDecode(trimmed.slice(CLIENT_CONFIG_PREFIX.length));
  if (packed.byteLength <= NONCE_BYTES) throw new Error('client config payload is too short');
  const nonce = packed.slice(0, NONCE_BYTES);
  const encrypted = packed.slice(NONCE_BYTES);
  const key = await configKey();
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, encrypted));
  const parsed = JSON.parse(dec.decode(plain)) as WebTunnelClientConfigV1;
  validatePayload(parsed);
  return parsed;
}

async function configKey(): Promise<any> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(CONFIG_KEY_LABEL));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function validatePayload(payload: WebTunnelClientConfigV1): void {
  if (!payload || payload.schema !== 1) throw new Error('unsupported client config schema');
  if (!payload.clientId || typeof payload.clientId !== 'string') throw new Error('client config missing client id');
  if (!payload.clientName || typeof payload.clientName !== 'string') throw new Error('client config missing client name');
  if (payload.carrier !== 'webrtc') throw new Error('client config carrier must be webrtc');
  if (!payload.baleSession || typeof payload.baleSession.jwt !== 'string' || !payload.baleSession.jwt) {
    throw new Error('client config missing Bale session');
  }
  if (!payload.baleSession.userId || !payload.baleSession.userAccessHash) {
    throw new Error('client config missing Bale account identity');
  }
  if (!payload.serverPeer || typeof payload.serverPeer.chatId !== 'number' || !payload.serverPeer.chatType) {
    throw new Error('client config missing server peer');
  }
  if (!payload.serverUuid || typeof payload.serverUuid !== 'string') throw new Error('client config missing server uuid');
  if (!isValidUuid(payload.serverUuid)) throw new Error('client config has invalid server uuid');
  if (payload.serverPeer.chatType !== 'PRIVATE' && payload.serverPeer.chatType !== 'GROUP') {
    throw new Error('client config has unsupported server peer type');
  }
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}
