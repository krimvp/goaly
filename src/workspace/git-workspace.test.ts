import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitWorkspace } from './git-workspace';
import type { ExecFn, RunExecWrapper } from './git-workspace';

/** Run a git command synchronously in `cwd`, throwing on failure (setup only). */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

describe('GitWorkspace (integration, real git)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-gw-test-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    await writeFile(join(root, 'file.txt'), 'hello\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('diffHash is stable across two calls with no change', async () => {
    const ws = new GitWorkspace(root);
    const a = await ws.diffHash();
    const b = await ws.diffHash();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it('diffHash changes after modifying a file', async () => {
    const ws = new GitWorkspace(root);
    const before = await ws.diffHash();
    await writeFile(join(root, 'file.txt'), 'goodbye\n');
    const after = await ws.diffHash();
    expect(after).not.toBe(before);
  });

  it('diffHash succeeds when the excluded state dir is gitignored AND present', async () => {
    // Regression: `git add -A -- . :(exclude).goaly` exits non-zero ("paths are ignored") when
    // `.goaly/` is gitignored and present, which used to make diffHash throw and crash-loop the
    // driver. The excluded dir must be kept out of the hash without failing.
    await writeFile(join(root, '.gitignore'), '.goaly/\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'ignore .goaly');
    await mkdir(join(root, '.goaly'));
    await writeFile(join(root, '.goaly', 'state.json'), '{"run":1}\n');

    const ws = new GitWorkspace(root);
    const a = await ws.diffHash();
    expect(a).toMatch(/^[0-9a-f]{40}$/);

    // Mutating the excluded dir must not change the hash (it is excluded), proving it never
    // entered the tree despite being present.
    await writeFile(join(root, '.goaly', 'state.json'), '{"run":2}\n');
    const b = await ws.diffHash();
    expect(b).toBe(a);
  });

  it('diffHash ignores verifier-produced artifacts under a configured exclude', async () => {
    // A verifier writes coverage output / __pycache__ between iterations; with those paths excluded,
    // the tree hash must not move, so a no-op agent can't look like it changed something.
    const ws = new GitWorkspace(root, undefined, ['.goaly', 'coverage', '__pycache__']);
    const before = await ws.diffHash();

    await mkdir(join(root, 'coverage'));
    await writeFile(join(root, 'coverage', 'lcov.info'), 'TN:\nSF:file.txt\n');
    await mkdir(join(root, '__pycache__'));
    await writeFile(join(root, '__pycache__', 'mod.pyc'), 'bytecode\n');

    const after = await ws.diffHash();
    expect(after).toBe(before);

    // A real source change is still detected (the exclude doesn't blind genuine work).
    await writeFile(join(root, 'file.txt'), 'changed by the agent\n');
    expect(await ws.diffHash()).not.toBe(before);
  });

  it('diffHash does not mutate the real git index', async () => {
    const ws = new GitWorkspace(root);
    // Introduce an unstaged change.
    await writeFile(join(root, 'file.txt'), 'changed\n');
    await ws.diffHash();
    // The real index must still be clean (the change remains unstaged).
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect(status.stdout).toContain(' M file.txt');
  });

  it('diff includes untracked files', async () => {
    const ws = new GitWorkspace(root);
    await writeFile(join(root, 'new-untracked.txt'), 'fresh\n');
    const text = await ws.diff();
    expect(text).toContain('new-untracked.txt');
  });

  it('diff includes tracked modifications', async () => {
    const ws = new GitWorkspace(root);
    await writeFile(join(root, 'file.txt'), 'modified\n');
    const text = await ws.diff();
    expect(text).toContain('file.txt');
    expect(text).toContain('modified');
  });

  it("run('exit 3') yields exitCode 3 and never rejects", async () => {
    const ws = new GitWorkspace(root);
    const result = await ws.run('exit 3');
    expect(result.exitCode).toBe(3);
  });

  it('run captures stdout', async () => {
    const ws = new GitWorkspace(root);
    const result = await ws.run('printf hello-world');
    expect(result.stdout).toContain('hello-world');
    expect(result.exitCode).toBe(0);
  });

  it('run captures stderr', async () => {
    const ws = new GitWorkspace(root);
    const result = await ws.run('printf oops 1>&2');
    expect(result.stderr).toContain('oops');
  });

  it('run kills a command that exceeds timeoutMs and fails closed (non-zero exit)', async () => {
    const ws = new GitWorkspace(root);
    const start = Date.now();
    const result = await ws.run('sleep 10', { timeoutMs: 100 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('timed out');
    // It must return promptly (well under the 10s sleep), proving the SIGKILL fired.
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('run without a timeout still completes normally', async () => {
    const ws = new GitWorkspace(root);
    const result = await ws.run('printf done');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');
  });

  it('scrubs credential-looking env vars from the verify command', async () => {
    process.env.GOALY_TEST_TOKEN = 'super-secret';
    process.env.GOALY_TEST_PLAIN = 'visible';
    try {
      const ws = new GitWorkspace(root);
      const secret = await ws.run('printf "%s" "${GOALY_TEST_TOKEN}"');
      const plain = await ws.run('printf "%s" "${GOALY_TEST_PLAIN}"');
      expect(secret.stdout).toBe('');
      expect(plain.stdout).toBe('visible');
    } finally {
      delete process.env.GOALY_TEST_TOKEN;
      delete process.env.GOALY_TEST_PLAIN;
    }
  });

  it('passes the full env when scrubbing is disabled', async () => {
    process.env.GOALY_TEST_TOKEN = 'super-secret';
    try {
      const ws = new GitWorkspace(root, undefined, ['.goaly'], false);
      const secret = await ws.run('printf "%s" "${GOALY_TEST_TOKEN}"');
      expect(secret.stdout).toBe('super-secret');
    } finally {
      delete process.env.GOALY_TEST_TOKEN;
    }
  });

  it('fileHash hashes a real file, tracks edits, and returns null for missing/escaping paths', async () => {
    const ws = new GitWorkspace(root);
    await writeFile(join(root, 'gen.test.ts'), 'test("x", () => {})');
    const h1 = await ws.fileHash('gen.test.ts');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);

    // A content change yields a different hash (the guard's tamper signal).
    await writeFile(join(root, 'gen.test.ts'), 'test("x", () => { expect(true).toBe(true) })');
    const h2 = await ws.fileHash('gen.test.ts');
    expect(h2).not.toBe(h1);

    expect(await ws.fileHash('nope.test.ts')).toBeNull();
    expect(await ws.fileHash('../escape.txt')).toBeNull();
  });

  it('exec runner is injectable (no real process spawned)', async () => {
    const calls: string[][] = [];
    const ws = new GitWorkspace(root, async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('write-tree')) {
        return { stdout: 'a'.repeat(40) + '\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });
    const hash = await ws.diffHash();
    expect(hash).toBe('a'.repeat(40));
    expect(calls.some((c) => c.includes('add'))).toBe(true);
    expect(calls.some((c) => c.includes('write-tree'))).toBe(true);
  });

  // WORKSPEC §2 "Subtlety": the sandbox runLauncher must wrap ONLY the exec used by run() — never
  // the git plumbing (diff/diffHash), which needs the real `.git` + full env. This pins the seam
  // where that mistake would actually happen: the #runExec split in the constructor.
  it('runLauncher wraps ONLY run(); diff/diffHash use the bare git-plumbing exec', async () => {
    const plumbingCalls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      plumbingCalls.push([cmd, ...args]);
      if (args.includes('write-tree')) {
        return { stdout: 'b'.repeat(40) + '\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    // The launcher spy rewrites the verify command so a wrapped run() is observable, and records
    // that it was invoked. If the plumbing went through it, the recorded count would be > 1.
    const wrapCalls: Array<{ cmd: string; args: string[] }> = [];
    const runLauncher: RunExecWrapper = (inner) => async (cmd, args, opts) => {
      wrapCalls.push({ cmd, args });
      return inner('JAILED', [cmd, ...args], opts);
    };

    const ws = new GitWorkspace(root, exec, ['.goaly'], true, runLauncher);

    // Plumbing: must NOT touch the launcher.
    await ws.diffHash();
    await ws.diff();
    expect(wrapCalls).toEqual([]); // launcher never invoked for git plumbing
    expect(plumbingCalls.some((c) => c[0] === 'git')).toBe(true);
    expect(plumbingCalls.every((c) => c[0] !== 'JAILED')).toBe(true);

    // run(): must go through the wrapped exec exactly once.
    const before = plumbingCalls.length;
    const result = await ws.run('npm test');
    expect(wrapCalls).toEqual([{ cmd: 'npm test', args: [] }]);
    expect(result.exitCode).toBe(0);
    // The wrapped exec rewrote the command to the synthetic 'JAILED' binary — proof run() used it.
    expect(plumbingCalls[before]?.[0]).toBe('JAILED');
  });
});
