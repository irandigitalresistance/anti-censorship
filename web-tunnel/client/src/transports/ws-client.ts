import type { Transport } from '@webtunnel/shared';
import WebSocket, { type RawData } from 'ws';

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export async function openClientWebSocket(url: string): Promise<Transport> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });

  let onMessage: ((bytes: Uint8Array) => void) | null = null;
  let onClose: ((reason: string) => void) | null = null;

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    onMessage?.(toBytes(data));
  });
  ws.on('close', (code, reasonBuf) => {
    onClose?.(reasonBuf.toString('utf8') || `ws closed (${code})`);
  });
  ws.on('error', (err) => {
    onClose?.(`ws error: ${err.message}`);
  });

  return {
    send(bytes) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(bytes, { binary: true });
    },
    onMessage(cb) {
      onMessage = cb;
    },
    onClose(cb) {
      onClose = cb;
    },
    close(reason = 'closed') {
      try {
        ws.close(1000, reason);
      } catch {
        /* ignore */
      }
    },
  };
}
