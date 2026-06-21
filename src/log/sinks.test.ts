import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConsoleSink,
  RotatingFileSink,
  nodeLogFs,
  jsonLine,
  prettyLine,
  type LogFs,
} from './sinks';
import type { LogRecord } from './logger';

const rec = (over: Partial<LogRecord> = {}): LogRecord => ({
  level: 'info',
  msg: 'hello',
  ts: 0, // 1970-01-01T00:00:00.000Z
  fields: {},
  ...over,
});

/** In-memory LogFs so rotation is tested without touching disk. */
class MemFs implements LogFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
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
  rename(from: string, to: string): void {
    const f = this.files.get(from);
    if (f === undefined) return;
    this.files.set(to, f);
    this.files.delete(from);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  ensureDir(dir: string): void {
    this.dirs.add(dir);
  }
}

describe('formatters', () => {
  it('jsonLine emits one parseable JSON object per line, metadata first', () => {
    const line = jsonLine(rec({ level: 'warn', msg: 'm', fields: { runId: 'r', n: 2 } }));
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'warn',
      msg: 'm',
      runId: 'r',
      n: 2,
    });
  });

  it('prettyLine renders an aligned human line with key=value fields', () => {
    const line = prettyLine(rec({ level: 'info', msg: 'agent ran', fields: { status: 'completed', n: 3 } }));
    expect(line).toBe('1970-01-01T00:00:00.000Z INFO  agent ran status=completed n=3\n');
  });

  it('prettyLine omits the field section when there are no fields', () => {
    expect(prettyLine(rec({ msg: 'bare' }))).toBe('1970-01-01T00:00:00.000Z INFO  bare\n');
  });
});

describe('ConsoleSink', () => {
  it('writes the formatted line to the injected writer', () => {
    const lines: string[] = [];
    const sink = new ConsoleSink({ write: (l) => lines.push(l), format: jsonLine });
    sink.write(rec({ msg: 'x' }));
    expect(JSON.parse(lines[0]!).msg).toBe('x');
  });

  it('defaults to a pretty line', () => {
    const lines: string[] = [];
    new ConsoleSink({ write: (l) => lines.push(l) }).write(rec({ msg: 'y' }));
    expect(lines[0]).toContain('INFO  y');
  });
});

describe('RotatingFileSink', () => {
  it('appends successive records to the live file', () => {
    const fs = new MemFs();
    const sink = new RotatingFileSink({ path: '/logs/goaly.log', fs, format: jsonLine });
    sink.write(rec({ msg: 'one' }));
    sink.write(rec({ msg: 'two' }));
    const body = fs.files.get('/logs/goaly.log') ?? '';
    expect(body.trim().split('\n')).toHaveLength(2);
    expect(fs.dirs.has('/logs')).toBe(true);
  });

  it('rotates when the next write would exceed maxBytes and keeps maxBackups archives', () => {
    const fs = new MemFs();
    // Each line is 5 bytes (> maxBytes=4), so every write after the first rotates.
    const sink = new RotatingFileSink({
      path: '/l/app.log',
      fs,
      maxBytes: 4,
      maxBackups: 2,
      format: (r) => `${r.msg}\n`,
    });
    sink.write(rec({ msg: 'AAAA' })); // live
    sink.write(rec({ msg: 'BBBB' })); // rotate: AAAA -> .1
    sink.write(rec({ msg: 'CCCC' })); // rotate: BBBB -> .1, AAAA -> .2
    sink.write(rec({ msg: 'DDDD' })); // rotate: CCCC -> .1, BBBB -> .2, AAAA (.3) dropped

    expect(fs.files.get('/l/app.log')).toBe('DDDD\n');
    expect(fs.files.get('/l/app.log.1')).toBe('CCCC\n');
    expect(fs.files.get('/l/app.log.2')).toBe('BBBB\n');
    expect(fs.exists('/l/app.log.3')).toBe(false); // dropped — retention cap holds
  });

  it('continues an existing file by reading its size first', () => {
    const fs = new MemFs();
    fs.append('/x/goaly.log', 'preexisting\n'); // 12 bytes
    const sink = new RotatingFileSink({ path: '/x/goaly.log', fs, maxBytes: 10, format: (r) => `${r.msg}\n` });
    sink.write(rec({ msg: 'next' })); // size>0 and 12+5>10 → rotate the preexisting content
    expect(fs.files.get('/x/goaly.log.1')).toBe('preexisting\n');
    expect(fs.files.get('/x/goaly.log')).toBe('next\n');
  });

  it('writes and rotates against the real filesystem (nodeLogFs), creating the directory', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'goaly-log-'));
    const file = path.join(tmp, 'nested', 'goaly.log');
    try {
      const sink = new RotatingFileSink({
        path: file,
        fs: nodeLogFs,
        maxBytes: 4,
        maxBackups: 1,
        format: (r) => `${r.msg}\n`,
      });
      sink.write(rec({ msg: 'AAAA' }));
      sink.write(rec({ msg: 'BBBB' })); // rotate: AAAA -> .1

      expect((await readFile(file, 'utf8')).trim()).toBe('BBBB');
      expect((await readFile(`${file}.1`, 'utf8')).trim()).toBe('AAAA');
      // The retention cap holds on disk: only the live file + one archive exist.
      expect((await readdir(path.dirname(file))).sort()).toEqual(['goaly.log', 'goaly.log.1']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('clamps maxBackups to at least 1', () => {
    const fs = new MemFs();
    const sink = new RotatingFileSink({
      path: '/z/app.log',
      fs,
      maxBytes: 4,
      maxBackups: 0,
      format: (r) => `${r.msg}\n`,
    });
    sink.write(rec({ msg: 'AA' }));
    sink.write(rec({ msg: 'BB' })); // rotates to .1 (min one backup kept)
    expect(fs.files.get('/z/app.log')).toBe('BB\n');
    expect(fs.files.get('/z/app.log.1')).toBe('AA\n');
  });
});
