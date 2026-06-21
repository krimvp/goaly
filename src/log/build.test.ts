import { describe, it, expect } from 'vitest';
import { buildLogger } from './build';
import { noopLogger } from './logger';
import type { LogFs } from './sinks';

class MemFs implements LogFs {
  readonly files = new Map<string, string>();
  size(path: string): number | null {
    const f = this.files.get(path);
    return f === undefined ? null : Buffer.byteLength(f, 'utf8');
  }
  append(path: string, data: string): void {
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  rename(): void {}
  remove(): void {}
  ensureDir(): void {}
}

describe('buildLogger', () => {
  it('returns the noop logger when every sink is disabled', () => {
    expect(buildLogger({ level: 'info', console: false })).toBe(noopLogger);
  });

  it('wires a console writer and binds the given fields', () => {
    const lines: string[] = [];
    const logger = buildLogger({
      level: 'info',
      console: (l) => lines.push(l),
      fields: { runId: 'run-9' },
    });
    logger.info('up');
    expect(lines[0]).toContain('up');
    expect(lines[0]).toContain('runId=run-9');
  });

  it('respects the level floor', () => {
    const lines: string[] = [];
    const logger = buildLogger({ level: 'warn', console: (l) => lines.push(l) });
    logger.info('quiet');
    logger.error('loud');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('loud');
  });

  it('wires a rotating file sink that writes through the injected fs', () => {
    const fs = new MemFs();
    const logger = buildLogger({
      level: 'debug',
      console: false,
      file: { path: '/run/goaly.log', fs },
      now: () => 0,
    });
    logger.debug('to file', { k: 1 });
    const body = fs.files.get('/run/goaly.log') ?? '';
    expect(JSON.parse(body)).toMatchObject({ level: 'debug', msg: 'to file', k: 1 });
  });

  it('can drive both console and file sinks at once', () => {
    const fs = new MemFs();
    const lines: string[] = [];
    const logger = buildLogger({
      level: 'info',
      console: (l) => lines.push(l),
      file: { path: '/d/goaly.log', fs },
    });
    logger.info('both');
    expect(lines).toHaveLength(1);
    expect(fs.files.get('/d/goaly.log')).toContain('both');
  });
});
