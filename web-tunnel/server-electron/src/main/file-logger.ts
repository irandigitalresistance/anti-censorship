import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function installFileLogger(appName: string): string {
  const dir = path.join(os.homedir(), '.webtunnel');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${appName}-debug.log`);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  stream.write(
    `\n========= ${new Date().toISOString()} ${appName} start pid=${process.pid} =========\n`,
  );

  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');

  const write = (level: string, args: unknown[]): void => {
    const ts = new Date().toISOString().slice(11, 23);
    stream.write(`${ts} [${level}] ${fmt(args)}\n`);
  };

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...a: unknown[]) => { try { write('LOG', a); } catch {} origLog(...a); };
  console.warn = (...a: unknown[]) => { try { write('WARN', a); } catch {} origWarn(...a); };
  console.error = (...a: unknown[]) => { try { write('ERR', a); } catch {} origError(...a); };

  process.on('uncaughtException', (err) => { try { write('FATAL', ['uncaughtException', err]); } catch {} });
  process.on('unhandledRejection', (reason) => { try { write('FATAL', ['unhandledRejection', reason]); } catch {} });

  console.log(`[logger] writing to ${logFile}`);
  return logFile;
}
