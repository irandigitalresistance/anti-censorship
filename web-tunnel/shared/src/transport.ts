export interface Transport {
  send(bytes: Uint8Array): void | Promise<void>;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(reason?: string): void;
}
