import { describe, it, expect } from 'vitest';
import { StructuredLogger, noopLogger, LogLevel, type LogRecord, type LogSink } from './logger';

class CaptureSink implements LogSink {
  readonly records: LogRecord[] = [];
  write(record: LogRecord): void {
    this.records.push(record);
  }
}

function loggerAt(level: 'debug' | 'info' | 'warn' | 'error') {
  const sink = new CaptureSink();
  let t = 0;
  const logger = new StructuredLogger({ level, sinks: [sink], now: () => (t += 1) });
  return { logger, sink };
}

describe('StructuredLogger', () => {
  it('drops records below the configured level and keeps the rest', () => {
    const { logger, sink } = loggerAt('warn');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(sink.records.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('emits all four levels when the floor is debug', () => {
    const { logger, sink } = loggerAt('debug');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(sink.records).toHaveLength(4);
  });

  it('stamps each record with the injected clock', () => {
    const { logger, sink } = loggerAt('debug');
    logger.info('one');
    logger.info('two');
    expect(sink.records.map((r) => r.ts)).toEqual([1, 2]);
  });

  it('merges call fields over bound (child) fields', () => {
    const { logger, sink } = loggerAt('debug');
    const child = logger.child({ runId: 'run-1', seam: 'driver' });
    child.info('hello', { seam: 'override', extra: 7 });
    expect(sink.records[0]?.fields).toEqual({ runId: 'run-1', seam: 'override', extra: 7 });
  });

  it('child fields accumulate across nesting', () => {
    const { logger, sink } = loggerAt('debug');
    logger.child({ a: 1 }).child({ b: 2 }).warn('nested');
    expect(sink.records[0]?.fields).toEqual({ a: 1, b: 2 });
  });

  it('a record with no call fields still carries the bound fields', () => {
    const { logger, sink } = loggerAt('debug');
    logger.child({ runId: 'r' }).info('bare');
    expect(sink.records[0]?.fields).toEqual({ runId: 'r' });
  });

  it('fans out to every sink', () => {
    const a = new CaptureSink();
    const b = new CaptureSink();
    const logger = new StructuredLogger({ level: 'info', sinks: [a, b] });
    logger.info('x');
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
  });

  it('is fail-closed: a throwing sink never propagates and the others still receive', () => {
    const good = new CaptureSink();
    const bad: LogSink = {
      write() {
        throw new Error('disk full');
      },
    };
    const logger = new StructuredLogger({ level: 'info', sinks: [bad, good] });
    expect(() => logger.error('boom')).not.toThrow();
    expect(good.records).toHaveLength(1);
  });

  it('defaults the clock to Date.now when none is injected', () => {
    const sink = new CaptureSink();
    const before = Date.now();
    new StructuredLogger({ level: 'info', sinks: [sink] }).info('t');
    expect(sink.records[0]?.ts).toBeGreaterThanOrEqual(before);
  });
});

describe('noopLogger', () => {
  it('accepts every call without throwing and returns itself from child', () => {
    expect(() => {
      noopLogger.debug('d');
      noopLogger.info('i', { a: 1 });
      noopLogger.warn('w');
      noopLogger.error('e');
    }).not.toThrow();
    expect(noopLogger.child({ x: 1 })).toBe(noopLogger);
  });
});

describe('LogLevel schema', () => {
  it('accepts the known levels and rejects anything else', () => {
    expect(LogLevel.parse('debug')).toBe('debug');
    expect(LogLevel.safeParse('loud').success).toBe(false);
  });
});
