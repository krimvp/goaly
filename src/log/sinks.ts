import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { LogLevel, LogRecord, LogSink } from './logger';

/**
 * One JSON object per line — structured, greppable, machine-parseable. The default file format.
 * `ts`/`level`/`msg` lead; bound + call fields follow (callers avoid those reserved keys).
 */
export function jsonLine(r: LogRecord): string {
  return `${JSON.stringify({ ts: new Date(r.ts).toISOString(), level: r.level, msg: r.msg, ...r.fields })}\n`;
}

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/** A compact human line for a console: `<iso> LEVEL msg key=value …`. The default console format. */
export function prettyLine(r: LogRecord): string {
  const kv = Object.entries(r.fields)
    .map(([k, v]) => `${k}=${renderValue(v)}`)
    .join(' ');
  return `${new Date(r.ts).toISOString()} ${LEVEL_TAG[r.level]} ${r.msg}${kv ? ` ${kv}` : ''}\n`;
}

function renderValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export type ConsoleSinkOptions = {
  /** Where formatted lines go. Default `process.stderr` (stdout carries the run outcome). */
  write?: (line: string) => void;
  format?: (r: LogRecord) => string;
};

/** Writes records to a line-writer (stderr by default), human-formatted by default. */
export class ConsoleSink implements LogSink {
  readonly #write: (line: string) => void;
  readonly #format: (r: LogRecord) => string;

  constructor(opts: ConsoleSinkOptions = {}) {
    this.#write =
      opts.write ??
      ((line): void => {
        process.stderr.write(line);
      });
    this.#format = opts.format ?? prettyLine;
  }

  write(record: LogRecord): void {
    this.#write(this.#format(record));
  }
}

/**
 * The minimal synchronous filesystem the rotating sink needs. Injected so rotation logic is
 * tested with an in-memory fake and never touches disk. The real implementation is {@link nodeLogFs}.
 */
export interface LogFs {
  /** File size in bytes, or `null` if it does not exist. */
  size(path: string): number | null;
  append(path: string, data: string): void;
  exists(path: string): boolean;
  rename(from: string, to: string): void;
  remove(path: string): void;
  ensureDir(dir: string): void;
}

export const nodeLogFs: LogFs = {
  size(path: string): number | null {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  append(path: string, data: string): void {
    appendFileSync(path, data);
  },
  exists(path: string): boolean {
    return existsSync(path);
  },
  rename(from: string, to: string): void {
    renameSync(from, to);
  },
  remove(path: string): void {
    unlinkSync(path);
  },
  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  },
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 3;

export type RotatingFileSinkOptions = {
  path: string;
  /** Rotate once the live file would exceed this many bytes. Default 5 MiB. */
  maxBytes?: number;
  /** How many rotated archives to keep (`<path>.1` … `<path>.N`). Default 3, min 1. */
  maxBackups?: number;
  fs?: LogFs;
  format?: (r: LogRecord) => string;
};

/**
 * Size-based rotating file sink. When the next write would exceed `maxBytes`, the live file is
 * rolled to `<path>.1`, older archives shift up, and the oldest beyond `maxBackups` is dropped —
 * so on-disk diagnostics are capped (`maxBytes × (maxBackups + 1)`) without external tooling.
 * Writes are synchronous (a diagnostics file, not a hot path) and never split a record.
 */
export class RotatingFileSink implements LogSink {
  readonly #path: string;
  readonly #maxBytes: number;
  readonly #maxBackups: number;
  readonly #fs: LogFs;
  readonly #format: (r: LogRecord) => string;
  /** Cached live-file size; `null` until the first write initializes it (and the directory). */
  #size: number | null = null;

  constructor(opts: RotatingFileSinkOptions) {
    this.#path = opts.path;
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxBackups = Math.max(1, opts.maxBackups ?? DEFAULT_MAX_BACKUPS);
    this.#fs = opts.fs ?? nodeLogFs;
    this.#format = opts.format ?? jsonLine;
  }

  write(record: LogRecord): void {
    const line = this.#format(record);
    const bytes = Buffer.byteLength(line, 'utf8');
    if (this.#size === null) {
      this.#fs.ensureDir(dirname(this.#path));
      this.#size = this.#fs.size(this.#path) ?? 0;
    }
    if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
      this.#rotate();
    }
    this.#fs.append(this.#path, line);
    this.#size += bytes;
  }

  #rotate(): void {
    const oldest = `${this.#path}.${this.#maxBackups}`;
    if (this.#fs.exists(oldest)) this.#fs.remove(oldest);
    for (let i = this.#maxBackups - 1; i >= 1; i--) {
      const from = `${this.#path}.${i}`;
      if (this.#fs.exists(from)) this.#fs.rename(from, `${this.#path}.${i + 1}`);
    }
    if (this.#fs.exists(this.#path)) this.#fs.rename(this.#path, `${this.#path}.1`);
    this.#size = 0;
  }
}
