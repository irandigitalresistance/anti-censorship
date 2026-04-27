export type ChatType = 'PRIVATE' | 'GROUP' | 'BOT' | 'CHANNEL';

export interface Peer {
  chatId: number;
  chatType: ChatType;
}

export interface IncomingMessage {
  chat: Peer;
  senderId: number;
  text: string | null;
  messageId: number | null;
  date: number | null;
}

export type SidecarMessageListener = (msg: IncomingMessage) => void;

export interface ISidecar {
  sendMessage(peer: Peer, text: string): Promise<{ messageId: number | null; date: number | null }>;
  onMessage(cb: SidecarMessageListener): () => void;
  onClose(cb: (reason: string) => void): () => void;
  readonly me: { id: number; name: string | null; phone: string | null } | null;
  close(): Promise<void>;
}
