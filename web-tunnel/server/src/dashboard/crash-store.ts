import { randomUUID } from 'node:crypto';

/** Wire schema for client-reported crashes. Mirrors shared/src/version.ts. */
export interface CrashReportInput {
  reportId?: string;
  source: string;
  appVersion: string;
  occurredAt: number;
  kind: string;
  message: string;
  stack: string;
  meta?: Record<string, string | number | null> | null;
}

export interface CrashRecord extends CrashReportInput {
  id: string;
  receivedAt: number;
}

export class CrashStore {
  private readonly crashes: CrashRecord[] = [];

  constructor(private readonly maxRecords = 200, private readonly maxStackBytes = 32_000) {}

  add(input: CrashReportInput): CrashRecord {
    const trimmedStack = (input.stack ?? '').slice(0, this.maxStackBytes);
    const record: CrashRecord = {
      ...input,
      id: input.reportId ?? randomUUID(),
      receivedAt: Date.now(),
      stack: trimmedStack,
      meta: input.meta ?? null,
    };
    this.crashes.unshift(record);
    while (this.crashes.length > this.maxRecords) this.crashes.pop();
    return record;
  }

  list(): CrashRecord[] {
    return this.crashes.slice();
  }

  get(id: string): CrashRecord | null {
    return this.crashes.find((c) => c.id === id) ?? null;
  }
}
