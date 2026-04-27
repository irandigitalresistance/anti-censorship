// Minimal gRPC-Web client for Bale. Each call is HTTP POST to
// `https://next-ws.bale.ai/{service}/{method}` with `application/grpc-web+proto`.
//
// Request framing: [1 byte compressed_flag | 4 bytes length (big-endian) | payload].
// Response framing: same, optionally followed by a trailer block that begins
// with the literal ASCII string "grpc-status". See aiobale/utils/grpc_post.py.

const BALE_BASE_URL = 'https://next-ws.bale.ai';

export interface GrpcWebOptions {
  /** Defaults to BALE_BASE_URL. */
  baseUrl?: string;
  /** Override headers, overlaid on top of the defaults. */
  headers?: Record<string, string>;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
  /** Called once per call with the wall-clock duration. */
  onTiming?: (info: { service: string; method: string; ms: number; bytesIn: number; bytesOut: number }) => void;
}

export class GrpcError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly httpStatus: number,
    public readonly rawBody?: Uint8Array,
  ) {
    super(message);
    this.name = 'GrpcError';
  }
}

/** aiobale.client.session._make_id — mt_session_id looks like Date.now() value. */
export function makeSessionId(): string {
  return String(Date.now());
}

/** Request-time Bale headers. access_token cookie is optional (post-login). */
export function defaultBaleHeaders(opts: { sessionId?: string; accessToken?: string } = {}): Record<string, string> {
  const sid = opts.sessionId ?? makeSessionId();
  const h: Record<string, string> = {
    'content-type': 'application/grpc-web+proto',
    'x-grpc-web': '1',
    'session_id': sid,
    'mt_session_id': sid,
    'app_version': '151668',
    'mt_app_version': '151668',
    'browser_type': '1',
    'mt_browser_type': '1',
    'browser_version': '143.0.0.0',
    'mt_browser_version': '143.0.0.0',
    'os_type': '4',
    'mt_os_type': '4',
    'accept': 'application/grpc-web+proto',
    'origin': 'https://web.bale.ai',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  };
  if (opts.accessToken) h['cookie'] = `access_token=${opts.accessToken}`;
  return h;
}

function frameRequest(payload: Uint8Array): Uint8Array {
  const buf = new ArrayBuffer(5 + payload.byteLength);
  const out = new Uint8Array(buf);
  out[0] = 0; // not compressed
  const view = new DataView(buf);
  view.setUint32(1, payload.byteLength, false); // big-endian
  out.set(payload, 5);
  return out;
}

/**
 * Parse a gRPC-Web response body. Splits payload (preceded by a 5-byte header
 * with high bit 0) from trailers (preceded by a 5-byte header with high bit set
 * (0x80) — `grpc-status: 0\r\ngrpc-message: ...\r\n`).
 */
export function parseGrpcWebBody(body: Uint8Array): { payload: Uint8Array; trailers: Record<string, string> } {
  let offset = 0;
  let payload: Uint8Array = body.subarray(0, 0);
  const trailers: Record<string, string> = {};
  while (offset + 5 <= body.byteLength) {
    const flag = body[offset]!;
    const view = new DataView(body.buffer, body.byteOffset + offset + 1, 4);
    const len = view.getUint32(0, false);
    const frameStart = offset + 5;
    const frameEnd = frameStart + len;
    if (frameEnd > body.byteLength) break;
    const frame = body.subarray(frameStart, frameEnd);
    if ((flag & 0x80) === 0) {
      payload = frame;
    } else {
      const text = new TextDecoder().decode(frame);
      for (const line of text.split(/\r\n|\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        trailers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
    }
    offset = frameEnd;
  }
  return { payload, trailers };
}

export async function grpcUnary<ReqT, ResT>(
  service: string,
  method: string,
  request: ReqT,
  encode: (r: ReqT) => Uint8Array,
  decode: (b: Uint8Array) => ResT,
  opts: GrpcWebOptions & { sessionId?: string; accessToken?: string } = {},
): Promise<ResT> {
  const baseUrl = opts.baseUrl ?? BALE_BASE_URL;
  const url = `${baseUrl}/${service}/${method}`;
  const framed = frameRequest(encode(request));
  const headers = { ...defaultBaleHeaders({ sessionId: opts.sessionId, accessToken: opts.accessToken }), ...opts.headers };
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: framed,
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  const { payload, trailers } = parseGrpcWebBody(buf);
  // gRPC-Web "trailers-only" responses (typically error paths) put grpc-status
  // in HTTP response headers instead of a trailer frame. Check both.
  const headerStatus = resp.headers.get('grpc-status');
  const headerMessage = resp.headers.get('grpc-message');
  const status = trailers['grpc-status'] ?? (headerStatus ?? undefined);
  const message = trailers['grpc-message'] ?? (headerMessage ?? undefined);
  if (resp.status !== 200 || (status != null && status !== '0')) {
    throw new GrpcError(
      `gRPC ${service}/${method} failed: http=${resp.status} status=${status ?? 'n/a'} msg=${message ?? ''}`,
      status != null ? Number(status) : -1,
      resp.status,
      buf,
    );
  }
  opts.onTiming?.({ service, method, ms: Date.now() - t0, bytesIn: buf.byteLength, bytesOut: framed.byteLength });
  return decode(payload);
}
