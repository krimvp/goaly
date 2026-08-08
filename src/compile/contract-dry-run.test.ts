import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractDryRunCompiler } from './contract-dry-run';
import { SATISFIABILITY_GUARDRAIL } from './critiqued-compiler';
import { FakeCompiler, FakeScratchHost, makeFakeContract } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { RunConfig } from '../domain/config';
import { FsScratchHost } from '../workspace/scratch-copy';
import { sha256Hex } from '../util/hash';

const generateConfig = RunConfig.parse({ goal: 'build the widget', verifier: { kind: 'generate' } });
const existingConfig = RunConfig.parse({
  goal: 'build the widget',
  verifier: { kind: 'existing', ref: 'npm test' },
});

/** A contract that authored one verification file and runs one deterministic rung. */
function authoredContract(overrides: Parameters<typeof makeFakeContract>[0] = {}) {
  return makeFakeContract({
    rungs: [{ kind: 'deterministic', command: 'npm test' }],
    generatedFiles: [{ path: 'verify/check.test.mjs', sha256: sha256Hex('assert(true)') }],
    ...overrides,
  });
}

const REFERENCE = JSON.stringify({
  files: [{ path: 'src/widget.mjs', content: 'export const solution = 42;' }],
});

describe('ContractDryRunCompiler (compile-time positive control, issue #115)', () => {
  it('freezes the contract unchanged when a reference implementation greens the bar', async () => {
    const contract = authoredContract();
    const inner = new FakeCompiler(contract);
    const scratch = new FakeScratchHost({ results: [{ exitCode: 0, stdout: 'ok', stderr: '' }] });
    const compiler = new ContractDryRunCompiler({
      inner,
      llm: new FakeLlm([REFERENCE]),
      scratch,
    });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(scratch.written).toEqual([{ path: 'src/widget.mjs', content: 'export const solution = 42;' }]);
    expect(scratch.ran).toEqual(['npm test']);
    expect(scratch.destroyed).toBe(1);
  });

  it('refuses the freeze when the reference implementation cannot green the bar', async () => {
    const inner = new FakeCompiler(authoredContract());
    const scratch = new FakeScratchHost({
      results: [{ exitCode: 1, stdout: '', stderr: 'expected spy to have been called' }],
    });
    const compiler = new ContractDryRunCompiler({
      inner,
      llm: new FakeLlm([REFERENCE]),
      scratch,
    });

    await expect(compiler.compile(generateConfig)).rejects.toThrow(
      /refusing to freeze an UNSATISFIABLE bar/,
    );
    // The refusal feeds the bounded re-author loop as a COMPILE_FAILED reason, fenced by the
    // anti-softening rail so "make it satisfiable" is never read as "make it easier".
    await expect(
      new ContractDryRunCompiler({
        inner: new FakeCompiler(authoredContract()),
        llm: new FakeLlm([REFERENCE]),
        scratch: new FakeScratchHost({
          results: [{ exitCode: 1, stdout: '', stderr: 'expected spy to have been called' }],
        }),
      }).compile(generateConfig),
    ).rejects.toThrow(SATISFIABILITY_GUARDRAIL.slice(0, 40));
  });

  it('never leaks the reference implementation into the refusal fed back to the author', async () => {
    const secret = 'export function solve() { return "THE-ANSWER"; }';
    const inner = new FakeCompiler(authoredContract());
    const compiler = new ContractDryRunCompiler({
      inner,
      llm: new FakeLlm([JSON.stringify({ files: [{ path: 'src/solve.mjs', content: secret }] })]),
      scratch: new FakeScratchHost({ results: [{ exitCode: 1, stdout: '', stderr: 'red' }] }),
    });

    const error = await compiler.compile(generateConfig).catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('THE-ANSWER');
    expect((error as Error).message).not.toContain(secret);
  });

  it('writes the reference ONLY into the scratch copy and destroys it on every exit path', async () => {
    const scratchGreen = new FakeScratchHost({ results: [{ exitCode: 0, stdout: '', stderr: '' }] });
    const green = await new ContractDryRunCompiler({
      inner: new FakeCompiler(authoredContract()),
      llm: new FakeLlm([REFERENCE]),
      scratch: scratchGreen,
    }).compile(generateConfig);
    // The frozen contract carries no trace of the reference implementation.
    expect(green.generatedFiles.map((f) => f.path)).toEqual(['verify/check.test.mjs']);
    expect(scratchGreen.destroyed).toBe(1);

    const scratchRed = new FakeScratchHost({ results: [{ exitCode: 1, stdout: '', stderr: 'red' }] });
    await expect(
      new ContractDryRunCompiler({
        inner: new FakeCompiler(authoredContract()),
        llm: new FakeLlm([REFERENCE]),
        scratch: scratchRed,
      }).compile(generateConfig),
    ).rejects.toThrow();
    expect(scratchRed.destroyed).toBe(1);
  });

  it('discards reference files that collide with the frozen verification files', async () => {
    const scratch = new FakeScratchHost({ results: [{ exitCode: 0, stdout: '', stderr: '' }] });
    await new ContractDryRunCompiler({
      inner: new FakeCompiler(authoredContract()),
      llm: new FakeLlm([
        JSON.stringify({
          files: [
            { path: './verify/check.test.mjs', content: 'assert(true) // rewritten bar' },
            { path: 'src/widget.mjs', content: 'real work' },
          ],
        }),
      ]),
      scratch,
    }).compile(generateConfig);

    expect(scratch.written.map((f) => f.path)).toEqual(['src/widget.mjs']);
  });

  it('runs the contract setup first, and only the DETERMINISTIC rungs (judge rungs are out of scope)', async () => {
    const contract = authoredContract({
      setup: 'npm ci',
      rungs: [
        { kind: 'deterministic', command: 'npm test' },
        { kind: 'deterministic', command: 'node smoke.mjs', label: 'smoke' },
        { kind: 'judge', rubric: 'is it good', quorum: 1, confidenceFloor: 0.5 },
      ],
    });
    const scratch = new FakeScratchHost({
      results: [
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 0, stdout: '', stderr: '' },
        { exitCode: 0, stdout: '', stderr: '' },
      ],
    });
    await new ContractDryRunCompiler({
      inner: new FakeCompiler(contract),
      llm: new FakeLlm([REFERENCE]),
      scratch,
    }).compile(generateConfig);

    expect(scratch.ran).toEqual(['npm ci', 'npm test', 'node smoke.mjs']);
  });

  it('is inert for a user-supplied --verify-cmd and for a contract that authored no files', async () => {
    const existingLlm = new FakeLlm([REFERENCE]);
    const existingScratch = new FakeScratchHost();
    const contract = makeFakeContract();
    await new ContractDryRunCompiler({
      inner: new FakeCompiler(contract),
      llm: existingLlm,
      scratch: existingScratch,
    }).compile(existingConfig);
    expect(existingLlm.requests).toHaveLength(0);
    expect(existingScratch.destroyed).toBe(0);

    const noFilesLlm = new FakeLlm([REFERENCE]);
    await new ContractDryRunCompiler({
      inner: new FakeCompiler(makeFakeContract()),
      llm: noFilesLlm,
      scratch: new FakeScratchHost(),
    }).compile(generateConfig);
    expect(noFilesLlm.requests).toHaveLength(0);
  });

  describe('fail-open: an infrastructure failure freezes exactly as today', () => {
    it('no LLM answer', async () => {
      const contract = authoredContract();
      const llm = new FakeLlm([]);
      llm.complete = async () => {
        throw new Error('LLM CLI claude timed out');
      };
      const result = await new ContractDryRunCompiler({
        inner: new FakeCompiler(contract),
        llm,
        scratch: new FakeScratchHost(),
      }).compile(generateConfig);
      expect(result.contractHash).toBe(contract.contractHash);
    });

    it('an unparseable reference implementation', async () => {
      const contract = authoredContract();
      const result = await new ContractDryRunCompiler({
        inner: new FakeCompiler(contract),
        llm: new FakeLlm(['sorry, I cannot do that']),
        scratch: new FakeScratchHost(),
      }).compile(generateConfig);
      expect(result.contractHash).toBe(contract.contractHash);
    });

    it('a scratch-copy failure', async () => {
      const contract = authoredContract();
      const result = await new ContractDryRunCompiler({
        inner: new FakeCompiler(contract),
        llm: new FakeLlm([REFERENCE]),
        scratch: new FakeScratchHost({ createError: new Error('ENOSPC') }),
      }).compile(generateConfig);
      expect(result.contractHash).toBe(contract.contractHash);
    });

    it('a rung that timed out (could not be evaluated) is never a red', async () => {
      const contract = authoredContract();
      const result = await new ContractDryRunCompiler({
        inner: new FakeCompiler(contract),
        llm: new FakeLlm([REFERENCE]),
        scratch: new FakeScratchHost({
          results: [{ exitCode: 124, stdout: '', stderr: 'killed', timedOut: true }],
        }),
      }).compile(generateConfig);
      expect(result.contractHash).toBe(contract.contractHash);
    });

    it('a rung that could not be started is never a red', async () => {
      const contract = authoredContract();
      const result = await new ContractDryRunCompiler({
        inner: new FakeCompiler(contract),
        llm: new FakeLlm([REFERENCE]),
        scratch: new FakeScratchHost({
          results: [{ exitCode: 127, stdout: '', stderr: 'no shell', spawnFailed: true }],
        }),
      }).compile(generateConfig);
      expect(result.contractHash).toBe(contract.contractHash);
    });

    it('a setup command that cannot run in the scratch copy', async () => {
      const contract = authoredContract({ setup: 'npm ci' });
      const scratch = new FakeScratchHost({ results: [{ exitCode: 1, stdout: '', stderr: 'no network' }] });
      const result = await new ContractDryRunCompiler({
        inner: new FakeCompiler(contract),
        llm: new FakeLlm([REFERENCE]),
        scratch,
      }).compile(generateConfig);
      expect(result.contractHash).toBe(contract.contractHash);
      expect(scratch.ran).toEqual(['npm ci']); // the rungs never ran on an unprepared tree
      expect(scratch.destroyed).toBe(1);
    });

    it('a reference implementation that only rewrites the frozen bar', async () => {
      const contract = authoredContract();
      const scratch = new FakeScratchHost();
      const result = await new ContractDryRunCompiler({
        inner: new FakeCompiler(contract),
        llm: new FakeLlm([
          JSON.stringify({ files: [{ path: 'verify/check.test.mjs', content: 'assert(true)' }] }),
        ]),
        scratch,
      }).compile(generateConfig);
      expect(result.contractHash).toBe(contract.contractHash);
      expect(scratch.written).toEqual([]);
    });
  });
});

/**
 * The issue #114 regression, executed for real: a frozen bar whose call-count assertion sits AFTER
 * the spy was restored can never hold, no matter how correct the implementation is. It runs a real
 * scratch copy and a real `node` subprocess — the whole point of the positive control is that it
 * answers by EXECUTION rather than by asking a model its opinion.
 */
describe('ContractDryRunCompiler — issue #114 regression (post-mockRestore call-count assertion)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  });

  /**
   * The authored (frozen) bar. `restore()` clears the recorded calls exactly as vitest's
   * `mockRestore()` / jest's `restoreAllMocks()` do, so `assertAfterRestore` reproduces #114.
   */
  function barSource(assertAfterRestore: boolean): string {
    return [
      "import assert from 'node:assert/strict';",
      "import { api, render } from '../src/widget.mjs';",
      'function spyOn(obj, key) {',
      '  const original = obj[key];',
      '  const spy = { calls: [], restore() { obj[key] = original; spy.calls.length = 0; } };',
      '  obj[key] = (...args) => { spy.calls.push(args); return original.apply(obj, args); };',
      '  return spy;',
      '}',
      "const spy = spyOn(api, 'format');",
      "assert.equal(render('hi'), '[hi]');",
      ...(assertAfterRestore
        ? [
            'spy.restore();',
            "assert.ok(spy.calls.length > 0, 'expected api.format to have been called');",
          ]
        : [
            'const calls = spy.calls.length;',
            'spy.restore();',
            "assert.ok(calls > 0, 'expected api.format to have been called');",
          ]),
      "console.log('ok');",
    ].join('\n');
  }

  /** A genuinely correct implementation of the goal, routed through the public `api`. */
  const REFERENCE_IMPL = JSON.stringify({
    files: [
      {
        path: 'src/widget.mjs',
        content: [
          'export const api = { format(s) { return `[${s}]`; } };',
          'export function render(s) { return api.format(s); }',
        ].join('\n'),
      },
    ],
  });

  async function runDryRun(assertAfterRestore: boolean) {
    const root = await mkdtemp(join(tmpdir(), 'goaly-dryrun-114-'));
    roots.push(root);
    await mkdir(join(root, 'verify'), { recursive: true });
    const bar = barSource(assertAfterRestore);
    await writeFile(join(root, 'verify', 'check.mjs'), bar, 'utf-8');

    const contract = makeFakeContract({
      goal: 'build a widget renderer and use it',
      rungs: [
        { kind: 'deterministic', command: `"${process.execPath}" verify/check.mjs` },
      ],
      generatedFiles: [{ path: 'verify/check.mjs', sha256: sha256Hex(bar) }],
    });
    const compiler = new ContractDryRunCompiler({
      inner: new FakeCompiler(contract),
      llm: new FakeLlm([REFERENCE_IMPL]),
      scratch: new FsScratchHost(root),
      timeoutMs: 60_000,
    });
    return { root, contract, result: await compiler.compile(generateConfig).catch((e: unknown) => e) };
  }

  it('REJECTS a bar that asserts a call count after the spy was restored', async () => {
    const { root, result } = await runDryRun(true);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/refusing to freeze an UNSATISFIABLE bar/);
    expect((result as Error).message).toMatch(/expected api\.format to have been called/);
    // SAFETY: the reference implementation never reached the real workspace.
    expect((await readdir(root)).sort()).toEqual(['verify']);
  });

  it('freezes the same bar once the call count is captured BEFORE the restore', async () => {
    const { contract, result, root } = await runDryRun(false);

    expect(result).not.toBeInstanceOf(Error);
    expect((result as { contractHash: string }).contractHash).toBe(contract.contractHash);
    expect((await readdir(root)).sort()).toEqual(['verify']);
  });
});
