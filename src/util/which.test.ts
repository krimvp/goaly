import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { which } from './which';

describe('which', () => {
  it('finds a binary present on PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'which-'));
    try {
      const bin = join(dir, 'mytool');
      await writeFile(bin, '#!/bin/sh\n');
      await chmod(bin, 0o755);
      expect(which('mytool', { PATH: dir })).toBe(true);
      expect(which('nope', { PATH: dir })).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks an explicit path directly (separator present)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'which-'));
    try {
      const bin = join(dir, 'tool');
      await writeFile(bin, 'x');
      expect(which(bin, {})).toBe(true);
      expect(which(join(dir, 'absent'), {})).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false on an empty PATH and skips empty PATH segments', () => {
    expect(which('anything', { PATH: '' })).toBe(false);
    expect(which('anything', { PATH: `${delimiter}${delimiter}` })).toBe(false);
  });
});
