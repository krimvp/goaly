import { z } from 'zod';

/**
 * The diagnostic logging seam. This is human-facing, leveled observability for the Driver and
 * the seams — NOT durability. The write-ahead run log (`src/runlog/`) stays the single source of
 * truth for replay/resume; nothing here is ever read back to reconstruct state.
 *
 * Logging is *wiring*, like harness/model selection: it never enters the frozen contract, never
 * reaches the pure reducer, and a logging failure must never crash a run (fail-closed). The
 * reducer (`src/orchestrator/`) does not log at all — invariant #1 keeps it pure.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Zod schema for a log level (parsed at the CLI seam, fails closed on an unknown value). */
export const LogLevel = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevel>;

/** Numeric severity for threshold comparisons (higher = more severe). */
export const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

/**
 * A single structured record. `ts` is stamped from an injected clock so tests are deterministic.
 * `fields` are the bound (child) fields already merged with the per-call fields. Sinks own
 * formatting; the record stays data.
 */
export type LogRecord = {
  readonly level: LogLevel;
  readonly msg: string;
  readonly ts: number;
  readonly fields: LogFields;
};

/** A destination for records. The logger guards `write` so a throwing sink never propagates. */
export interface LogSink {
  write(record: LogRecord): void;
}

/** The leveled logger surface the Driver/seams depend on. */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that binds `fields` onto every record (e.g. `{ runId }`). */
  child(fields: LogFields): Logger;
}

export type StructuredLoggerOptions = {
  /** Records below this level are dropped. */
  level: LogLevel;
  sinks: readonly LogSink[];
  /** Epoch-ms source. Default `Date.now`; inject for deterministic tests. */
  now?: () => number;
  /** Fields bound onto every record from this logger. */
  fields?: LogFields;
};

/** The real logger: level-filters, stamps a timestamp, merges fields, fans out to every sink. */
export class StructuredLogger implements Logger {
  readonly #level: LogLevel;
  readonly #sinks: readonly LogSink[];
  readonly #now: () => number;
  readonly #fields: LogFields;

  constructor(opts: StructuredLoggerOptions) {
    this.#level = opts.level;
    this.#sinks = opts.sinks;
    this.#now = opts.now ?? ((): number => Date.now());
    this.#fields = opts.fields ?? {};
  }

  debug(msg: string, fields?: LogFields): void {
    this.#emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.#emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.#emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.#emit('error', msg, fields);
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger({
      level: this.#level,
      sinks: this.#sinks,
      now: this.#now,
      fields: { ...this.#fields, ...fields },
    });
  }

  #emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[this.#level]) return;
    const record: LogRecord = {
      level,
      msg,
      ts: this.#now(),
      fields: fields !== undefined ? { ...this.#fields, ...fields } : this.#fields,
    };
    for (const sink of this.#sinks) {
      // Fail-closed: a diagnostics channel must never crash a run. A broken sink drops the
      // record (we can't log the logging failure without recursing) and the others still write.
      try {
        sink.write(record);
      } catch {
        /* intentionally ignored — diagnostics must never take down the orchestrator */
      }
    }
  }
}

/** A logger that does nothing — the safe default when no sink is configured (and for tests). */
class NoopLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}

export const noopLogger: Logger = new NoopLogger();
