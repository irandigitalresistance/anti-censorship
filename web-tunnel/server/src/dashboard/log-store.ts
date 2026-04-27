import { randomUUID } from 'node:crypto';
import type { V2LogReport } from '@webtunnel/shared';

export interface ClientLogSummary {
  id: string;
  tunnelId: string | null;
  source: string;
  fileName: string;
  contentType: string;
  receivedAt: number;
  size: number;
}

export interface ClientLogRecord extends ClientLogSummary {
  body: string;
}

export class ClientLogStore {
  private readonly logs: ClientLogRecord[] = [];

  constructor(private readonly maxRecordBytes = 512_000, private readonly maxRecords = 200) {}

  add(report: V2LogReport, tunnelId: string | null): ClientLogSummary {
    const trimmedBody = report.body.slice(0, this.maxRecordBytes);
    const record: ClientLogRecord = {
      id: randomUUID(),
      tunnelId,
      source: report.source,
      fileName: report.fileName,
      contentType: report.contentType,
      receivedAt: Date.now(),
      size: Buffer.byteLength(trimmedBody, 'utf8'),
      body: trimmedBody,
    };
    this.logs.unshift(record);
    while (this.logs.length > this.maxRecords) this.logs.pop();
    return this.toSummary(record);
  }

  list(): ClientLogSummary[] {
    return this.logs.map((log) => this.toSummary(log));
  }

  get(id: string): ClientLogRecord | null {
    return this.logs.find((log) => log.id === id) ?? null;
  }

  private toSummary(log: ClientLogRecord): ClientLogSummary {
    return {
      id: log.id,
      tunnelId: log.tunnelId,
      source: log.source,
      fileName: log.fileName,
      contentType: log.contentType,
      receivedAt: log.receivedAt,
      size: log.size,
    };
  }
}
