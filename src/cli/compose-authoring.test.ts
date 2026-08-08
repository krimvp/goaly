import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRunCompiler } from './compose-authoring';
import { RunConfig } from '../domain/config';
import { FakeCompiler, makeFakeContract } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { noopLogger } from '../log/logger';
import type { ExecFn } from '../workspace/git-workspace';
import { sha256Hex } from '../util/hash';

const generateConfig = RunConfig.parse({ goal: 'build the widget', verifier: { kind: 'generate' } });

const REFERENCE = JSON.stringify({
  files: [{ path: 'src/widget.mjs', content: 'export const solution = 42;' }],
});

function authoredContract(command = 'npm test') {
  return makeFakeContract({
    rungs: [{ kind: 'deterministic', command }],
    generatedFiles: [{ path: 'verify/check.test.mjs', sha256: sha256Hex('assert(true)') }],
  });
}

/**
 * The compile-time positive control copies the tree, writes LLM-authored code into it and EXECUTES
 * the contract's setup + rungs there. Those are the same untrusted commands the verifier seam runs,
 * so they must go through the same jail — a `--sandbox docker` run that quietly executed them bare
 * on the host would contradict the "never silently unsandboxed" guarantee (`refuseIfUnavailable`).
 */
describe('dryRunCompiler — the scratch runs under the configured sandbox', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  });

  async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'goaly-authoring-'));
    roots.push(root);
    await writeFile(join(root, 'keep.txt'), 'keep', 'utf-8');
    return root;
  }

  function recorder(seen: string[], tag: string): ExecFn {
    return async (cmd, args) => {
      seen.push(`${tag}:${cmd} ${args.join(' ')}`);
      return { stdout: '', stderr: '', code: 0 };
    };
  }

  it('routes every scratch command through the composed run launcher', async () => {
    const root = await workspace();
    const seen: string[] = [];
    const jailed = recorder(seen, 'jailed');
    const compiler = dryRunCompiler(
      new FakeCompiler(authoredContract()),
      generateConfig,
      () => new FakeLlm([REFERENCE]),
      root,
      undefined,
      noopLogger,
      undefined,
      () => jailed,
    );

    await compiler.compile(generateConfig);

    expect(seen).toEqual(['jailed:sh -c npm test']);
  });

  it('uses the plain exec when no sandbox is configured (default unchanged)', async () => {
    const root = await workspace();
    // With no launcher the scratch falls back to the real exec: `true` exits 0, so the bar greens.
    const contract = authoredContract('true');
    const compiler = dryRunCompiler(
      new FakeCompiler(contract),
      generateConfig,
      () => new FakeLlm([REFERENCE]),
      root,
      undefined,
      noopLogger,
      undefined,
      undefined,
    );

    expect((await compiler.compile(generateConfig)).contractHash).toBe(contract.contractHash);
  });
});
