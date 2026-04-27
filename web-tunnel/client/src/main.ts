import { deriveKeyFromPassword, PSK_SALT_INFO } from '@webtunnel/shared';
import { openClientWebSocket } from './transports/ws-client.js';
import { startSocks5Listener } from './socks5.js';
import { runClientTunnel } from './tunnel.js';

const SERVER_URL = process.env.WT_SERVER_URL ?? 'ws://127.0.0.1:4401/tunnel';
const SOCKS_PORT = Number(process.env.WT_SOCKS_PORT ?? 1080);
const SOCKS_HOST = process.env.WT_SOCKS_HOST ?? '127.0.0.1';
const PASSWORD = process.env.WT_PASSWORD ?? 'loopback-dev-password';

async function main(): Promise<void> {
  const psk = deriveKeyFromPassword(PASSWORD, new TextEncoder().encode(PSK_SALT_INFO));
  console.log(`[client] dialing ${SERVER_URL}`);
  const transport = await openClientWebSocket(SERVER_URL);
  const mux = await runClientTunnel(transport, psk);
  mux.onClose((r) => {
    console.log(`[client] tunnel closed: ${r}`);
    process.exit(1);
  });
  const listener = startSocks5Listener({
    host: SOCKS_HOST,
    port: SOCKS_PORT,
    mux,
    onConnect: (addr) => console.log(`[socks5] → ${addr.kind} ${addr.host}:${addr.port}`),
    onError: (e) => console.warn(`[socks5] ${e.message}`),
  });
  listener.on('listening', () => console.log(`[client] SOCKS5 on ${SOCKS_HOST}:${SOCKS_PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
