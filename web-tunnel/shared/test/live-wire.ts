// Manual live probe — not a vitest file. Run with:
//   cd shared && npx tsx test/live-wire.ts
// Does a real call to Bale with an invalid phone number to confirm wire format.

import { defaultBaleHeaders, parseGrpcWebBody } from '../src/bale/grpc-web.js';
import {
  decodePhoneAuthResponse,
  encodeStartPhoneAuth,
} from '../src/bale/messages.js';

async function main(): Promise<void> {
  const payload = encodeStartPhoneAuth({
    phoneNumber: 100000000000n,
    appId: 4,
    appKey: 'C28D46DC4C3A7A26564BFCC48B929086A95C93C98E789A19847BEE8627DE4E7D',
    deviceHash: 'test-device-hash',
    deviceTitle: 'TestClient',
    sendCodeType: 0,
  });
  const framed = new Uint8Array(5 + payload.byteLength);
  framed[0] = 0;
  new DataView(framed.buffer).setUint32(1, payload.byteLength, false);
  framed.set(payload, 5);
  console.log('REQ framed hex:', Buffer.from(framed).toString('hex'));

  const resp = await fetch('https://next-ws.bale.ai/bale.auth.v1.Auth/StartPhoneAuth', {
    method: 'POST',
    headers: defaultBaleHeaders(),
    body: framed,
  });
  console.log('HTTP', resp.status);
  for (const [k, v] of resp.headers.entries()) {
    if (k.startsWith('grpc') || k === 'content-type') console.log('  h:', k, '=', v);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  console.log('BODY hex:', Buffer.from(buf).toString('hex'));
  console.log('BODY text:', new TextDecoder('utf-8', { fatal: false }).decode(buf));

  const parsed = parseGrpcWebBody(buf);
  console.log('PAYLOAD hex:', Buffer.from(parsed.payload).toString('hex'));
  console.log('TRAILERS:', parsed.trailers);

  if (parsed.payload.byteLength > 0) {
    console.log('DECODED:', decodePhoneAuthResponse(parsed.payload));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
