import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Routes `console.log`, `console.warn`, `console.error`, plus uncaught errors
 * and unhandled rejections, to a file at `~/.webtunnel/<appName>-debug.log`.
 * Also keeps the stderr/stdout streams intact so Electron's terminal (if any)
 * sees the same output.
 *
 * Total on-disk footprint is capped at ≤ 4 MB:
 *   1 MB current + 3 × 1 MB rotated. Crash/queued logs (separate dir) add
 *   another ≤ 1 MB so the whole client diagnostic surface stays under 5 MB.
 *
 * Returns the absolute path of the log file so the UI can expose it.
 */
const MAX_BYTES = 1_000_000;
const KEEP = 3;
const SIZE_CHECK_EVERY_WRITES = 50;

export function installFileLogger(appName: string): string {
  const dir = path.join(os.homedir(), '.webtunnel');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${appName}-debug.log`);
  rotateLogs(logFile, MAX_BYTES, KEEP);
  let stream = fs.createWriteStream(logFile, { flags: 'a' });
  stream.write(
    `\n========= ${new Date().toISOString()} ${appName} start pid=${process.pid} =========\n`,
  );
  let writesSinceCheck = 0;

  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');

  const maybeRotate = (): void => {
    writesSinceCheck += 1;
    if (writesSinceCheck < SIZE_CHECK_EVERY_WRITES) return;
    writesSinceCheck = 0;
    try {
      const stat = fs.statSync(logFile);
      if (stat.size < MAX_BYTES) return;
      try { stream.end(); } catch { /* ignore */ }
      rotateLogs(logFile, MAX_BYTES, KEEP);
      stream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch { /* ignore */ }
  };

  const write = (level: string, args: unknown[]): void => {
    const ts = new Date().toISOString().slice(11, 23);
    stream.write(`${ts} [${level}] ${fmt(args)}\n`);
    maybeRotate();
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...a: unknown[]) => {
    try { write('LOG', a); } catch { /* ignore */ }
    origLog(...a);
  };
  console.warn = (...a: unknown[]) => {
    try { write('WARN', a); } catch { /* ignore */ }
    origWarn(...a);
  };
  console.error = (...a: unknown[]) => {
    try { write('ERR', a); } catch { /* ignore */ }
    origError(...a);
  };

  process.on('uncaughtException', (err) => {
    try { write('FATAL', ['uncaughtException', err]); } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { write('FATAL', ['unhandledRejection', reason]); } catch { /* ignore */ }
  });

  console.log(`[logger] writing to ${logFile}`);
  return logFile;
}

function rotateLogs(logFile: string, maxBytes: number, keep: number): void {
  try {
    if (!fs.existsSync(logFile)) return;
    const stat = fs.statSync(logFile);
    if (stat.size < maxBytes) return;
    // Drop the oldest, then shift each rotated file down a slot.
    const oldest = `${logFile}.${keep}`;
    if (fs.existsSync(oldest)) {
      try { fs.unlinkSync(oldest); } catch { /* ignore */ }
    }
    for (let i = keep; i >= 1; i -= 1) {
      const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const dst = `${logFile}.${i}`;
      if (!fs.existsSync(src)) continue;
      try { fs.renameSync(src, dst); } catch { /* ignore */ }
    }
  } catch {
    // ignore
  }
}
