import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeToolHost, type ShellExec } from './fs-host';

const okShell: ShellExec = async () => ({ stdout: '', stderr: '', code: 0 });

describe('NodeToolHost (path-guarded fs + injected shell)', () => {
  let root: string;
  let host: NodeToolHost;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'goaly-sdk-host-'));
    host = new NodeToolHost({ root, shell: okShell });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('write_file / read_file', () => {
    it('writes a file (creating parent dirs) and reads it back', async () => {
      const msg = await host.writeFile('src/deep/a.ts', 'hello');
      expect(msg).toMatch(/Wrote 5 bytes/);
      expect(await host.readFile('src/deep/a.ts')).toBe('hello');
    });

    it('reads an inclusive 1-based line range', async () => {
      await host.writeFile('f.txt', 'l1\nl2\nl3\nl4');
      expect(await host.readFile('f.txt', { startLine: 2, endLine: 3 })).toBe('l2\nl3');
    });

    it('explains when start_line is past the end of the file', async () => {
      await host.writeFile('f.txt', 'only');
      expect(await host.readFile('f.txt', { startLine: 99 })).toMatch(/past the end/);
    });
  });

  describe('list_dir', () => {
    it('lists entries with directories suffixed "/" (sorted)', async () => {
      await host.writeFile('b.ts', 'x');
      await mkdir(path.join(root, 'adir'));
      await host.writeFile('adir/inner.ts', 'y');
      expect(await host.listDir('.')).toBe('adir/\nb.ts');
    });

    it('reports an empty directory', async () => {
      await mkdir(path.join(root, 'empty'));
      expect(await host.listDir('empty')).toBe('(empty directory)');
    });
  });

  describe('grep', () => {
    it('returns file:line: text rows for matches', async () => {
      await host.writeFile('a.ts', 'const TARGET = 1;\nconst other = 2;');
      const out = await host.grep('TARGET', undefined);
      expect(out).toMatch(/a\.ts:1: const TARGET = 1;/);
    });

    it('reports no matches', async () => {
      await host.writeFile('a.ts', 'nothing here');
      expect(await host.grep('ZZZ', undefined)).toBe('(no matches)');
    });

    it('skips node_modules and .git', async () => {
      await mkdir(path.join(root, 'node_modules'));
      await writeFile(path.join(root, 'node_modules', 'pkg.js'), 'NEEDLE');
      await host.writeFile('real.ts', 'NEEDLE');
      const out = await host.grep('NEEDLE', undefined);
      expect(out).toMatch(/real\.ts/);
      expect(out).not.toMatch(/node_modules/);
    });

    it('returns a clear error for an invalid regular expression', async () => {
      expect(await host.grep('[', undefined)).toMatch(/invalid regular expression/);
    });
  });

  describe('edit_file', () => {
    it('applies a successful edit', async () => {
      await host.writeFile('a.ts', 'const a = 1;');
      expect(await host.editFile('a.ts', 'const a = 1;', 'const a = 2;')).toMatch(/Edited a\.ts \(exact match\)/);
      expect(await host.readFile('a.ts')).toBe('const a = 2;');
    });

    it('returns an actionable failure string (not a throw) when old_string is missing', async () => {
      await host.writeFile('a.ts', 'const a = 1;');
      const out = await host.editFile('a.ts', 'NOPE', 'x');
      expect(out).toMatch(/^edit_file failed:/);
      expect(await host.readFile('a.ts')).toBe('const a = 1;'); // unchanged
    });
  });

  describe('path traversal guard', () => {
    it('refuses to read outside the workspace', async () => {
      await expect(host.readFile('../escape.txt')).rejects.toThrow(/escapes the workspace/);
    });
    it('refuses to write outside the workspace', async () => {
      await expect(host.writeFile('../../evil.txt', 'x')).rejects.toThrow(/escapes the workspace/);
    });
  });

  describe('run_shell', () => {
    it('formats stdout/stderr/exit code from the injected shell', async () => {
      const shell: ShellExec = async () => ({ stdout: 'hi', stderr: 'warn', code: 3 });
      const h = new NodeToolHost({ root, shell });
      const out = await h.runShell('build');
      expect(out).toMatch(/exit code: 3/);
      expect(out).toMatch(/stdout:\nhi/);
      expect(out).toMatch(/stderr:\nwarn/);
    });

    it('flags a timed-out command', async () => {
      const shell: ShellExec = async () => ({ stdout: '', stderr: '', code: 124, timedOut: true });
      const h = new NodeToolHost({ root, shell });
      expect(await h.runShell('sleep 999')).toMatch(/timed out/);
    });
  });
});
