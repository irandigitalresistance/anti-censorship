import {
  SessionCipher,
  makeHandshakeOk,
  makeHandshakeReq,
  verifyHandshakeOk,
  verifyHandshakeReq,
} from './handshake.js';
import type { Transport } from './transport.js';

export async function clientHandshake(transport: Transport, psk: Uint8Array): Promise<SessionCipher> {
  const { wire: reqWire, clientNonce } = makeHandshakeReq(psk);
  return new Promise<SessionCipher>((resolve, reject) => {
    transport.onMessage((okWire) => {
      try {
        const { serverNonce } = verifyHandshakeOk(okWire, psk, clientNonce);
        resolve(SessionCipher.derive(psk, clientNonce, serverNonce));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    transport.onClose((reason) => reject(new Error(`transport closed during handshake: ${reason}`)));
    void transport.send(reqWire);
  });
}

export async function serverHandshake(transport: Transport, psk: Uint8Array): Promise<SessionCipher> {
  return new Promise<SessionCipher>((resolve, reject) => {
    transport.onMessage((reqWire) => {
      try {
        const { clientNonce } = verifyHandshakeReq(reqWire, psk);
        const { wire: okWire, serverNonce } = makeHandshakeOk(psk, clientNonce);
        void transport.send(okWire);
        resolve(SessionCipher.derive(psk, clientNonce, serverNonce));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    transport.onClose((reason) => reject(new Error(`transport closed during handshake: ${reason}`)));
  });
}
