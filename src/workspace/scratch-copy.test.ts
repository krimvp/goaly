import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, lstat, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { FsScratchHost } from './scratch-copy';

type ExecResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };

/** Records every command it is asked to run, and answers from a scripted table. */
function scriptedExec(table: Record<string, ExecResult>, seen: { cwd: string; cmd: string }[]) {
  return async (
    _cmd: string,
    args: string[],
    opts: { cwd: string; timeoutMs?: number },
  ): Promise<ExecResult> => {
    const command = args[1] ?? '';
    seen.push({ cwd: opts.cwd, cmd: command });
    return table[command] ?? { stdout: '', stderr: '', code: 0 };
  };
}

describe('FsScratchHost', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  });

  async function makeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'goaly-scratch-src-'));
    roots.push(root);
    return root;
  }

  it('duplicates the workspace, skipping .git and .goaly', async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.txt'), 'alpha', 'utf-8');
    await mkdir(join(root, '.git', 'objects'), { recursive: true });
    await writeFile(join(root, '.git', 'objects', 'x'), 'gitdata', 'utf-8');
    await mkdir(join(root, '.goaly'), { recursive: true });
    await writeFile(join(root, '.goaly', 'log.jsonl'), 'runlog', 'utf-8');

    const host = new FsScratchHost(root, { exec: scriptedExec({}, []) });
    const copy = await host.create();
    try {
      expect(await readFile(join(copy.root, 'src', 'a.txt'), 'utf-8')).toBe('alpha');
      await expect(stat(join(copy.root, '.git'))).rejects.toThrow();
      await expect(stat(join(copy.root, '.goaly'))).rejects.toThrow();
      expect(copy.root).not.toBe(root);
    } finally {
      await host.destroy(copy);
    }
  });

  it('destroy removes the copy and never throws on a missing directory', async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, 'f.txt'), 'x', 'utf-8');
    const host = new FsScratchHost(root, { exec: scriptedExec({}, []) });
    const copy = await host.create();
    await host.destroy(copy);
    await expect(stat(copy.root)).rejects.toThrow();
    await expect(host.destroy(copy)).resolves.toBeUndefined();
  });

  it('writes files into the copy only — the real workspace is untouched', async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, 'keep.txt'), 'keep', 'utf-8');
    const host = new FsScratchHost(root, { exec: scriptedExec({}, []) });
    const copy = await host.create();
    try {
      await copy.writeFile('nested/dir/impl.ts', 'export const x = 1;');
      expect(await readFile(join(copy.root, 'nested', 'dir', 'impl.ts'), 'utf-8')).toBe(
        'export const x = 1;',
      );
      await expect(stat(join(root, 'nested', 'dir', 'impl.ts'))).rejects.toThrow();
    } finally {
      await host.destroy(copy);
    }
  });

  it('refuses a write that escapes the scratch root (fail-closed)', async () => {
    const root = await makeWorkspace();
    const host = new FsScratchHost(root, { exec: scriptedExec({}, []) });
    const copy = await host.create();
    try {
      await expect(copy.writeFile('../escape.ts', 'nope')).rejects.toThrow(
        /refusing to write outside the scratch copy/,
      );
      await expect(copy.writeFile('/tmp/escape.ts', 'nope')).rejects.toThrow(
        /refusing to write outside the scratch copy/,
      );
    } finally {
      await host.destroy(copy);
    }
  });

  it('never copies a symlink — no entry in the scratch points back into the real tree', async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    await mkdir(join(outside, 'node_modules'), { recursive: true });
    await writeFile(join(outside, 'node_modules', 'dep.js'), 'real dep', 'utf-8');
    await writeFile(join(root, 'keep.txt'), 'keep', 'utf-8');
    // Both dialects a real workspace produces: a RELATIVE link (pnpm / npm link / monorepo) and an
    // absolute one. `fs.cp` resolves a relative target against the SOURCE and recreates it absolute,
    // so either way the copy would gain a path straight back into the user's tree.
    await symlink(relative(root, join(outside, 'node_modules')), join(root, 'node_modules'));
    await symlink(join(outside, 'node_modules', 'dep.js'), join(root, 'linked.js'));

    const host = new FsScratchHost(root, { exec: scriptedExec({}, []) });
    const copy = await host.create();
    try {
      expect(await readFile(join(copy.root, 'keep.txt'), 'utf-8')).toBe('keep');
      await expect(lstat(join(copy.root, 'node_modules'))).rejects.toThrow();
      await expect(lstat(join(copy.root, 'linked.js'))).rejects.toThrow();
    } finally {
      await host.destroy(copy);
    }
  });

  it('refuses a write that traverses a symlink out of the scratch (realpath guard)', async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    await mkdir(join(outside, 'src'), { recursive: true });
    await writeFile(join(outside, 'src', 'impl.ts'), 'original', 'utf-8');
    const host = new FsScratchHost(root, { exec: scriptedExec({}, []) });
    const copy = await host.create();
    try {
      // A symlinked DIRECTORY inside the copy: the lexical guard sees `<root>/src/impl.ts`.
      await symlink(join(outside, 'src'), join(copy.root, 'src'));
      await expect(copy.writeFile('src/impl.ts', 'THE-SOLUTION')).rejects.toThrow(
        /refusing to write outside the scratch copy/,
      );
      expect(await readFile(join(outside, 'src', 'impl.ts'), 'utf-8')).toBe('original');

      // A symlinked FILE inside the copy: writing it would follow the link into the real tree.
      await symlink(join(outside, 'src', 'impl.ts'), join(copy.root, 'linked.ts'));
      await expect(copy.writeFile('linked.ts', 'THE-SOLUTION')).rejects.toThrow(
        /refusing to write outside the scratch copy/,
      );
      expect(await readFile(join(outside, 'src', 'impl.ts'), 'utf-8')).toBe('original');
    } finally {
      await host.destroy(copy);
    }
  });

  it('runs commands in the copy, and reports a timeout as timedOut', async () => {
    const root = await makeWorkspace();
    const seen: { cwd: string; cmd: string }[] = [];
    const host = new FsScratchHost(root, {
      exec: scriptedExec(
        {
          'npm test': { stdout: 'ok', stderr: '', code: 0 },
          hang: { stdout: '', stderr: 'killed', code: 124, timedOut: true },
        },
        seen,
      ),
    });
    const copy = await host.create();
    try {
      const green = await copy.run('npm test');
      expect(green).toMatchObject({ exitCode: 0, stdout: 'ok' });
      expect(green.timedOut).toBeUndefined();
      const timedOut = await copy.run('hang', { timeoutMs: 10 });
      expect(timedOut.timedOut).toBe(true);
      expect(seen.every((s) => s.cwd === copy.root)).toBe(true);
    } finally {
      await host.destroy(copy);
    }
  });

  it('reports a spawn failure as spawnFailed instead of throwing', async () => {
    const root = await makeWorkspace();
    const host = new FsScratchHost(root, {
      exec: async () => {
        throw new Error('spawn ENOENT');
      },
    });
    const copy = await host.create();
    try {
      const r = await copy.run('anything');
      expect(r.spawnFailed).toBe(true);
      expect(r.exitCode).toBe(127);
      expect(r.stderr).toContain('spawn ENOENT');
    } finally {
      await host.destroy(copy);
    }
  });

  it('runs with a CREDENTIAL-SCRUBBED environment, exactly like the verifier seam', async () => {
    // The scratch runs the contract's `setup` and its deterministic rungs over a tree that also
    // holds LLM-authored reference code, one compile step before the freeze — and under the DEFAULT
    // `--sandbox none` there is no jail. Inheriting goaly's raw process.env would hand model-authored
    // code ANTHROPIC_API_KEY / AWS_* / GITHUB_TOKEN, which `GitWorkspace.run` has always denied.
    const root = await makeWorkspace();
    const before = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-scratch-secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-scratch-secret';
    process.env.GITHUB_TOKEN = 'gh-scratch-secret';
    process.env.GOALY_SCRATCH_HARMLESS = 'keep-me';
    let env: NodeJS.ProcessEnv | undefined;
    const host = new FsScratchHost(root, {
      exec: async (_cmd, _args, opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
        env = opts.env;
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    const copy = await host.create();
    try {
      await copy.run('printenv');
      expect(env).toBeDefined();
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env?.GITHUB_TOKEN).toBeUndefined();
      // …while the ordinary toolchain environment survives, or no `setup` could ever run.
      expect(env?.GOALY_SCRATCH_HARMLESS).toBe('keep-me');
      expect(env?.PATH).toBeDefined();
    } finally {
      await host.destroy(copy);
      for (const k of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'GOALY_SCRATCH_HARMLESS']) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  });

  it('aborts (and cleans up) when the workspace exceeds the entry budget', async () => {
    const root = await makeWorkspace();
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `f${i}.txt`), 'x', 'utf-8');
    }
    const host = new FsScratchHost(root, { exec: scriptedExec({}, []), maxEntries: 2 });
    await expect(host.create()).rejects.toThrow(/scratch-copy budget/);
  });
});
