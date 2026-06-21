import {
  StructuredLogger,
  noopLogger,
  type LogFields,
  type Logger,
  type LogLevel,
  type LogSink,
} from './logger';
import { ConsoleSink, RotatingFileSink, type LogFs } from './sinks';

export type FileLogOptions = {
  path: string;
  maxBytes?: number;
  maxBackups?: number;
  fs?: LogFs;
};

export type BuildLoggerOptions = {
  /** Minimum level. */
  level: LogLevel;
  /** Console sink: `true` (default) → stderr; `false` → none; or a custom line-writer. */
  console?: boolean | ((line: string) => void);
  /** Rotating file sink. Omit for no file. */
  file?: FileLogOptions;
  /** Epoch-ms source (tests). */
  now?: () => number;
  /** Fields bound onto every record (e.g. `{ runId }`). */
  fields?: LogFields;
};

/**
 * Assemble a {@link Logger} from resolved options. Returns the {@link noopLogger} when every sink
 * is disabled, so callers can always log unconditionally. The composition root and the CLI use
 * this; tests inject sinks/fs/clock to stay filesystem- and clock-free.
 */
export function buildLogger(opts: BuildLoggerOptions): Logger {
  const sinks: LogSink[] = [];
  if (opts.console !== false) {
    sinks.push(
      new ConsoleSink(typeof opts.console === 'function' ? { write: opts.console } : {}),
    );
  }
  if (opts.file !== undefined) sinks.push(new RotatingFileSink(opts.file));
  if (sinks.length === 0) return noopLogger;
  return new StructuredLogger({
    level: opts.level,
    sinks,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.fields !== undefined ? { fields: opts.fields } : {}),
  });
}
