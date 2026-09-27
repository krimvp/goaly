import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWorkspace, LegacyFileBaselineError } from './file-workspace';
import { sha256Hex } from '../util/hash';

type ExecResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };

const fakeExec = async (_cmd: string, args: string[], _opts: { cwd: string; timeoutMs?: number }): Promise<ExecResult> => {
  // args is ['-c', <user command>]
  const command = args[1] ?? '';
  if (command.startsWith('echo ')) {
    return { stdout: command.slice(5).trim().replace(/^["']|["']$/g, ''), stderr: '', code: 0 };
  }
  if (command === 'exit 0') return { stdout: '', stderr: '', code: 0 };
  if (command === 'exit 1') return { stdout: '', stderr: 'failed', code: 1 };
  return { stdout: '', stderr: '', code: 0 };
};

describe('FileWorkspace', () => {
  let root: string;
  let ws: FileWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-file-ws-'));
    ws = new FileWorkspace(root, fakeExec);
  });

  it('hashes the empty tree initially', async () => {
    const h1 = await ws.diffHash();
    const h2 = await ws.diffHash();
    expect(h1).toBe(h2);
  });

  it('diffHash changes when a file is added and is stable otherwise', async () => {
    const before = await ws.diffHash();
    await writeFile(join(root, 'hello.txt'), 'hi', 'utf-8');
    const after = await ws.diffHash();
    expect(after).not.toBe(before);
    const again = await ws.diffHash();
    expect(after).toBe(again);
  });

  it('diff() shows added files against the default empty baseline', async () => {
    await writeFile(join(root, 'hello.txt'), 'hi', 'utf-8');
    const d = await ws.diff();
    expect(d).toContain('+++ b/hello.txt');
    expect(d).toContain('+hi');
  });

  it('checkpoint() stores a baseline and diff() against it shows only later changes', async () => {
    await writeFile(join(root, 'a.txt'), '1', 'utf-8');
    const base = await ws.checkpoint();
    await writeFile(join(root, 'b.txt'), '2', 'utf-8');
    const d = await ws.diff(base);
    expect(d).toContain('+++ b/b.txt');
    expect(d).not.toContain('a.txt');
  });

  it('setBaseline() restores a prior checkpoint for diffing', async () => {
    await writeFile(join(root, 'a.txt'), '1', 'utf-8');
    const base = await ws.checkpoint();
    await writeFile(join(root, 'a.txt'), '2', 'utf-8');
    ws.setBaseline(base);
    const d = await ws.diff();
    expect(d).toContain('--- a/a.txt');
    expect(d).toContain('+++ b/a.txt');
    expect(d).toContain('-1');
    expect(d).toContain('+2');
    expect(d).not.toContain('-2');
  });

  it('shows removed file content from a checkpoint', async () => {
    await writeFile(join(root, 'a.txt'), 'before', 'utf-8');
    const base = await ws.checkpoint();
    await unlink(join(root, 'a.txt'));
    expect(await ws.diff(base)).toContain('-before');
  });

  it('counts file lines without a phantom trailing line', async () => {
    await writeFile(join(root, 'one.txt'), 'before\n');
    await writeFile(join(root, 'empty.txt'), '');
    const base = await ws.checkpoint();
    await writeFile(join(root, 'one.txt'), 'after\n');
    await writeFile(join(root, 'empty.txt'), 'new\n');
    const diff = await ws.diff(base);
    expect(diff).toContain('@@ -1,1 +1,1 @@\n-before\n+after');
    expect(diff).toContain('@@ -0,0 +1,1 @@\n+new');
    expect(diff).not.toContain('+-');
  });

  it('marks a changed final newline', async () => {
    await writeFile(join(root, 'a.txt'), 'a');
    const base = await ws.checkpoint();
    await writeFile(join(root, 'a.txt'), 'a\n');
    expect(await ws.diff(base)).toContain('-a\n\\ No newline at end of file\n+a');
  });

  it('rejects missing and corrupt named baselines', async () => {
    ws.setBaseline('missing');
    await expect(ws.diff()).rejects.toThrow();
    await writeFile(join(root, 'file.txt'), 'content');
    const base = await ws.checkpoint();
    await writeFile(join(root, '.goaly', 'baselines', `${base}.json`), '{bad');
    await expect(ws.diff(base)).rejects.toThrow();
  });

  it('reports a legacy hash-only checkpoint with a typed resume error', async () => {
    await writeFile(join(root, 'file.txt'), 'content');
    const base = await ws.checkpoint();
    await writeFile(join(root, '.goaly', 'baselines', `${base}.json`), JSON.stringify({
      'file.txt': sha256Hex('content'),
    }));
    await expect(ws.diff(base)).rejects.toBeInstanceOf(LegacyFileBaselineError);
  });

  it('fails closed when the tree cannot be scanned', async () => {
    await rm(root, { recursive: true });
    await expect(ws.diffHash()).rejects.toThrow();
    await expect(ws.diff()).rejects.toThrow();
    expect(await ws.isEmptyOfSource([])).toBe(false);
  });

  it('hashes binary file bytes', async () => {
    await writeFile(join(root, 'binary'), Buffer.from([0xff]));
    const before = await ws.diffHash();
    await writeFile(join(root, 'binary'), Buffer.from([0xfe]));
    expect(await ws.diffHash()).not.toBe(before);
    expect(await ws.fileHash('binary')).not.toBe(sha256Hex('�'));
  });

  it('applies glob excludes to nested paths', async () => {
    ws = new FileWorkspace(root, fakeExec, ['*.pyc', '*__pycache__*']);
    await mkdir(join(root, 'nested', '__pycache__'), { recursive: true });
    const before = await ws.diffHash();
    await writeFile(join(root, 'nested', 'cache.pyc'), 'bytecode');
    await writeFile(join(root, 'nested', '__pycache__', 'cache'), 'bytecode');
    expect(await ws.diffHash()).toBe(before);
    expect(await ws.diff()).toBe('');
  });

  it('scrubs credentials from the verify subprocess environment', async () => {
    let env: NodeJS.ProcessEnv | undefined;
    ws = new FileWorkspace(root, async (_cmd, _args, opts) => {
      env = opts.env;
      return { stdout: '', stderr: '', code: 0 };
    });
    process.env.GOALY_TEST_SECRET = 'must-not-leak';
    try {
      await ws.run('true');
      expect(env?.GOALY_TEST_SECRET).toBeUndefined();
      expect(env?.PATH).toBeTruthy();
    } finally {
      delete process.env.GOALY_TEST_SECRET;
    }
  });

  it('run() executes a command and returns the result', async () => {
    const r = await ws.run('echo hello');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello');
  });

  it('run() surfaces non-zero exits fail-closed', async () => {
    const r = await ws.run('exit 1');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('failed');
  });

  it('fileHash() returns the sha256 of a file', async () => {
    await writeFile(join(root, 'f.txt'), 'content', 'utf-8');
    expect(await ws.fileHash('f.txt')).toBe(sha256Hex('content'));
  });

  it('fileHash() returns null for missing files', async () => {
    expect(await ws.fileHash('missing.txt')).toBeNull();
  });

  it('readFile() returns file content', async () => {
    await writeFile(join(root, 'f.txt'), 'content', 'utf-8');
    expect(await ws.readFile('f.txt')).toBe('content');
  });

  it('readFile() returns null for missing files', async () => {
    expect(await ws.readFile('missing.txt')).toBeNull();
  });

  it('excludes the .goaly state dir from the manifest', async () => {
    await mkdir(join(root, '.goaly'), { recursive: true });
    await writeFile(join(root, '.goaly', 'state.json'), '{}', 'utf-8');
    await writeFile(join(root, 'src.txt'), 'x', 'utf-8');
    const d = await ws.diff();
    expect(d).toContain('src.txt');
    expect(d).not.toContain('.goaly/state.json');
  });

  it('isEmptyOfSource() is true for docs and meta only', async () => {
    await writeFile(join(root, 'README.md'), '# hi', 'utf-8');
    await writeFile(join(root, 'LICENSE'), 'MIT', 'utf-8');
    expect(await ws.isEmptyOfSource([])).toBe(true);
    await writeFile(join(root, 'src.js'), 'x', 'utf-8');
    expect(await ws.isEmptyOfSource([])).toBe(false);
  });

  it('isEmptyOfSource() ignores generated files', async () => {
    await writeFile(join(root, 'test.spec.js'), 'x', 'utf-8');
    expect(await ws.isEmptyOfSource(['test.spec.js'])).toBe(true);
  });
});
