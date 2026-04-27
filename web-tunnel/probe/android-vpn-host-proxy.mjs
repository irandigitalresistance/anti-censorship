import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

const MARKER_HOST = 'vpn.webtunnel.test';
const MARKER_HTML = '<html><body>android-vpn-ok</body></html>\n';
const HTTP_PORT = Number(process.env.WT_VPN_HTTP_PORT ?? '18081');
const SOCKS_PORT = Number(process.env.WT_VPN_SOCKS_PORT ?? '19080');

function parseSocksConnect(buffer) {
  if (buffer.length < 7) throw new Error('short CONNECT request');
  const atyp = buffer[3];
  let offset = 4;
  let host;
  if (atyp === 1) {
    host = Array.from(buffer.subarray(offset, offset + 4)).join('.');
    offset += 4;
  } else if (atyp === 3) {
    const len = buffer[offset];
    offset += 1;
    host = buffer.subarray(offset, offset + len).toString('utf8');
    offset += len;
  } else if (atyp === 4) {
    const parts = [];
    for (let i = 0; i < 8; i += 1) {
      parts.push(buffer.readUInt16BE(offset + i * 2).toString(16));
    }
    host = parts.join(':');
    offset += 16;
  } else {
    throw new Error(`unsupported atyp ${atyp}`);
  }
  const port = buffer.readUInt16BE(offset);
  offset += 2;
  return { host, port, nextOffset: offset };
}

const httpServer = http.createServer((req, res) => {
  const hostHeader = req.headers.host ?? '';
  const host = (() => {
    try {
      return new URL(`http://${hostHeader}`).hostname;
    } catch {
      return hostHeader.split(':', 1)[0] ?? '';
    }
  })();
  if (host === MARKER_HOST) {
    console.log(`[marker] ${req.method} ${req.url} host=${hostHeader}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(MARKER_HTML);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`unexpected host ${hostHeader}\n`);
});

const socksServer = net.createServer((clientSocket) => {
  let stage = 'greeting';
  let upstream = null;

  clientSocket.on('data', (chunk) => {
    try {
      if (stage === 'greeting') {
        if (chunk[0] !== 5) throw new Error('only SOCKS5 is supported');
        clientSocket.write(Buffer.from([5, 0]));
        stage = 'connect';
        return;
      }
      if (stage !== 'connect') {
        return;
      }
      if (chunk[0] !== 5 || chunk[1] !== 1) throw new Error('only CONNECT is supported');
      const { host, port, nextOffset } = parseSocksConnect(chunk);
      let targetHost = host;
      let targetPort = port;
      if (host === MARKER_HOST && port === 80) {
        targetHost = '127.0.0.1';
        targetPort = HTTP_PORT;
      }
      console.log(`[socks] ${host}:${port} -> ${targetHost}:${targetPort}`);
      upstream = net.connect({ host: targetHost, port: targetPort }, () => {
        clientSocket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        stage = 'stream';
        if (chunk.length > nextOffset) {
          upstream.write(chunk.subarray(nextOffset));
        }
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on('error', (error) => {
        console.error(`[upstream-error] ${host}:${port} ${error.message}`);
        try {
          clientSocket.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        } catch {
          // Ignore best-effort reply failures.
        }
        clientSocket.destroy();
      });
    } catch (error) {
      console.error(`[socks-error] ${error instanceof Error ? error.message : String(error)}`);
      clientSocket.destroy();
    }
  });

  clientSocket.on('error', (error) => {
    console.error(`[client-error] ${error.message}`);
  });
  clientSocket.on('close', () => {
    upstream?.destroy();
  });
});

await new Promise((resolve) => httpServer.listen(HTTP_PORT, '127.0.0.1', resolve));
await new Promise((resolve) => socksServer.listen(SOCKS_PORT, '127.0.0.1', resolve));

console.log(`[ready] marker http 127.0.0.1:${HTTP_PORT}`);
console.log(`[ready] socks5 127.0.0.1:${SOCKS_PORT}`);
