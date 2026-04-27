import net from 'node:net';
import type { LivekitConnectContext, LivekitRoomFactory } from './livekit-factory.js';
import type { LivekitRoomLike } from './livekit-transport.js';

type ClientMessage =
  | { type: 'hello'; roomName: string; identity: string }
  | { type: 'publish'; payload: string; destinationIdentities?: string[] }
  | { type: 'disconnect'; reason?: string };

type ServerMessage =
  | { type: 'welcome'; roomName: string; identity: string }
  | { type: 'data'; fromIdentity: string; payload: string }
  | { type: 'participant-left'; identity: string; reason?: string }
  | { type: 'error'; message: string };

export interface LocalLivekitOptions {
  host?: string;
  port?: number;
  logger?: (line: string) => void;
}

export interface LocalLivekitBrokerHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

interface Participant {
  readonly roomName: string;
  readonly identity: string;
  readonly socket: net.Socket;
  removed: boolean;
}

function defaultHost(opts?: LocalLivekitOptions): string {
  return opts?.host ?? process.env.WT_MOCK_LIVEKIT_HOST ?? '127.0.0.1';
}

function defaultPort(opts?: LocalLivekitOptions): number {
  return opts?.port ?? Number(process.env.WT_MOCK_LIVEKIT_PORT ?? 45200);
}

function writeJson(socket: net.Socket, msg: ServerMessage | ClientMessage): void {
  socket.write(`${JSON.stringify(msg)}\n`);
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decode(payload: string): Uint8Array {
  const buf = Buffer.from(payload, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function parseLines(chunk: string, carry: string): { lines: string[]; carry: string } {
  const all = carry + chunk;
  const parts = all.split('\n');
  const nextCarry = parts.pop() ?? '';
  const lines = parts.map((line) => line.trim()).filter((line) => line.length > 0);
  return { lines, carry: nextCarry };
}

export async function startLocalLivekitBroker(opts: LocalLivekitOptions = {}): Promise<LocalLivekitBrokerHandle> {
  const host = defaultHost(opts);
  const port = defaultPort(opts);
  const log = opts.logger ?? (() => undefined);
  const rooms = new Map<string, Map<string, Participant>>();

  const removeParticipant = (participant: Participant | null, reason: string): void => {
    if (!participant || participant.removed) return;
    participant.removed = true;
    const room = rooms.get(participant.roomName);
    if (!room) return;
    const current = room.get(participant.identity);
    if (current !== participant) return;
    room.delete(participant.identity);
    if (room.size === 0) {
      rooms.delete(participant.roomName);
      return;
    }
    const notice: ServerMessage = {
      type: 'participant-left',
      identity: participant.identity,
      reason,
    };
    for (const peer of room.values()) {
      writeJson(peer.socket, notice);
    }
  };

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let carry = '';
    let participant: Participant | null = null;

    const fail = (message: string): void => {
      writeJson(socket, { type: 'error', message });
      socket.end();
    };

    const handleLine = (line: string): void => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(line) as ClientMessage;
      } catch {
        fail('invalid JSON');
        return;
      }

      if (!participant) {
        if (msg.type !== 'hello') {
          fail('expected hello');
          return;
        }
        const room = rooms.get(msg.roomName) ?? new Map<string, Participant>();
        rooms.set(msg.roomName, room);
        const existing = room.get(msg.identity);
        if (existing) {
          existing.socket.end();
          removeParticipant(existing, 'duplicate identity');
        }
        participant = {
          roomName: msg.roomName,
          identity: msg.identity,
          socket,
          removed: false,
        };
        room.set(msg.identity, participant);
        writeJson(socket, { type: 'welcome', roomName: msg.roomName, identity: msg.identity });
        log(`[local-livekit] join room=${msg.roomName} identity=${msg.identity}`);
        return;
      }

      if (msg.type === 'publish') {
        const room = rooms.get(participant.roomName);
        if (!room) return;
        const targets = (msg.destinationIdentities?.length ?? 0) > 0
          ? msg.destinationIdentities!
          : Array.from(room.keys()).filter((identity) => identity !== participant!.identity);
        const frame: ServerMessage = {
          type: 'data',
          fromIdentity: participant.identity,
          payload: msg.payload,
        };
        for (const target of targets) {
          if (target === participant.identity) continue;
          const peer = room.get(target);
          if (!peer) continue;
          writeJson(peer.socket, frame);
        }
        return;
      }

      if (msg.type === 'disconnect') {
        socket.end();
        removeParticipant(participant, msg.reason ?? 'client disconnect');
        return;
      }

      fail(`unexpected message: ${msg.type}`);
    };

    socket.on('data', (chunk: string) => {
      const parsed = parseLines(chunk, carry);
      carry = parsed.carry;
      for (const line of parsed.lines) handleLine(line);
    });
    socket.on('close', () => removeParticipant(participant, 'socket closed'));
    socket.on('error', (error) => {
      log(`[local-livekit] socket error: ${error.message}`);
      removeParticipant(participant, `socket error: ${error.message}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      log(`[local-livekit] broker listening on ${host}:${port}`);
      resolve();
    });
  });

  return {
    host,
    port,
    async close() {
      for (const room of rooms.values()) {
        for (const participant of room.values()) {
          participant.socket.destroy();
        }
      }
      rooms.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function makeLocalLivekitRoomFactory(opts: LocalLivekitOptions = {}): LivekitRoomFactory {
  const host = defaultHost(opts);
  const port = defaultPort(opts);
  const log = opts.logger ?? (() => undefined);

  return async (ctx: LivekitConnectContext): Promise<LivekitRoomLike> => {
    const socket = net.createConnection({ host, port });
    socket.setEncoding('utf8');

    const dataHandlers = new Set<(bytes: Uint8Array, fromIdentity: string) => void>();
    const discHandlers = new Set<(reason: string) => void>();
    let carry = '';
    let ready = false;
    let finished = false;
    let finishReason = 'local livekit closed';

    const finish = (reason: string): void => {
      if (finished) return;
      finished = true;
      finishReason = reason;
      for (const cb of discHandlers) cb(reason);
    };

    const room: LivekitRoomLike = {
      localIdentity: ctx.identity,
      async publishData(bytes, publishOpts) {
        if (finished) throw new Error(finishReason);
        writeJson(socket, {
          type: 'publish',
          payload: encode(bytes),
          destinationIdentities: publishOpts?.destinationIdentities ?? [],
        });
      },
      onDataReceived(cb) {
        dataHandlers.add(cb);
        return () => dataHandlers.delete(cb);
      },
      onDisconnect(cb) {
        discHandlers.add(cb);
        if (finished) cb(finishReason);
        return () => discHandlers.delete(cb);
      },
      async disconnect(reason) {
        if (finished) return;
        finish(reason ?? 'local livekit disconnect');
        writeJson(socket, { type: 'disconnect', reason });
        socket.end();
      },
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const rejectOrFinish = (message: string): void => {
        const error = new Error(message);
        if (!ready) settleReject(error);
        else finish(message);
      };

      socket.on('connect', () => {
        writeJson(socket, {
          type: 'hello',
          roomName: ctx.roomName,
          identity: ctx.identity,
        });
      });

      socket.on('data', (chunk: string) => {
        const parsed = parseLines(chunk, carry);
        carry = parsed.carry;
        for (const line of parsed.lines) {
          let msg: ServerMessage;
          try {
            msg = JSON.parse(line) as ServerMessage;
          } catch {
            rejectOrFinish('invalid broker JSON');
            socket.destroy();
            return;
          }
          if (msg.type === 'welcome') {
            ready = true;
            settleResolve();
            continue;
          }
          if (msg.type === 'data') {
            const payload = decode(msg.payload);
            for (const cb of dataHandlers) cb(payload, msg.fromIdentity);
            continue;
          }
          if (msg.type === 'participant-left') {
            finish(msg.reason ? `peer ${msg.identity} left: ${msg.reason}` : `peer ${msg.identity} left`);
            socket.end();
            continue;
          }
          rejectOrFinish(msg.message);
          socket.destroy();
          return;
        }
      });

      socket.on('close', () => {
        if (!ready) {
          settleReject(new Error('local livekit connect failed'));
          return;
        }
        finish('local livekit socket closed');
      });
      socket.on('error', (error) => {
        log(`[local-livekit] client error: ${error.message}`);
        rejectOrFinish(`local livekit socket error: ${error.message}`);
      });
    });

    return room;
  };
}
