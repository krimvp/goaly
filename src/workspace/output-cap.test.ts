import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspace, type ExecFn, type ExecResult, realExec } from './git-workspace';
import { FsScratchHost } from './scratch-copy';
import { DeterministicVerifier, executionErrorReason } from '../verify/deterministic';
import { ContractDryRunCompiler } from '../compile/contract-dry-run';
import { FakeCompiler, FakeScratchHost, makeFakeContract } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { RunConfig } from '../domain/config';
import { sha256Hex } from '../util/hash';

/**
 * A command GOALY ITSELF KILLED for blowing the output cap is a could-not-EVALUATE outcome, not a red.
 *
 * `runProcess` SIGKILLs a child whose stdout+stderr exceeds `maxOutputBytes` and flags the result
 * `truncated`. That flag was dropped at the very next layer (`realExec` → `ExecResult`), `CommandResult`
 * had nowhere to carry it, and so `executionErrorReason` returned null: every consumer then read the
 * close-code fallback as an honest failure. Two things went wrong from that one dropped bit —
 * the compile-time dry run refused to freeze a perfectly sound contract because a chatty reference
 * implementation (or a verbose runner) out-printed the cap, and at run time the same kill surfaced as
 * a code red instead of `CONTRACT_UNEVALUABLE`.
 */

/** An exec that reports exactly what `runProcess` reports when it kills a child over the cap. */
const cappedExec: ExecFn = async () => ({
  stdout: 'a'.repeat(64),
  stderr: '',
  code: 1, // SIGKILL ⇒ no exit code ⇒ runProcess' `code ?? 1` fallback
  outputCapped: true,
});

describe('the output-cap kill is threaded as a could-not-evaluate signal', () => {
  it('executionErrorReason classifies an output-capped result', () => {
    expect(executionErrorReason({ exitCode: 1, stdout: '', stderr: '' })).toBeNull();
    expect(executionErrorReason({ exitCode: 1, stdout: '', stderr: '', outputCapped: true })).toMatch(
      /output/i,
    );
  });

  it('GitWorkspace.run carries it onto CommandResult', async () => {
    const ws = new GitWorkspace('/tmp/does-not-matter', cappedExec);
    const r = await ws.run('noisy');
    expect(r.outputCapped).toBe(true);
  });

  it('a scratch copy carries it too (the dry run runs its rungs there)', async () => {
    const source = await mkdtemp(join(tmpdir(), 'goaly-cap-src-'));
    try {
      const host = new FsScratchHost(source, { exec: cappedExec });
      const copy = await host.create();
      try {
        const r = await copy.run('noisy');
        expect(r.outputCapped).toBe(true);
      } finally {
        await host.destroy(copy);
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('a verifier rung killed over the cap is unevaluable, never a code red', async () => {
    const ws = new GitWorkspace('/tmp/does-not-matter', cappedExec);
    const verdict = await new DeterministicVerifier('npm test').verify(ws, 'goal', 'rubric');
    expect(verdict.pass).toBe(false); // still fail-closed
    expect(verdict.evaluable).toBe(false); // …but classified as could-not-evaluate
    expect(verdict.detail).toMatch(/output/i);
  });

  it('the contract dry run steps aside (fail-open) instead of refusing the freeze', async () => {
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      generatedFiles: [{ path: 'verify/check.test.mjs', sha256: sha256Hex('assert(true)') }],
    });
    const scratch = new FakeScratchHost({
      results: [{ exitCode: 1, stdout: '', stderr: '', outputCapped: true }],
    });
    const compiler = new ContractDryRunCompiler({
      inner: new FakeCompiler(contract),
      llm: new FakeLlm([JSON.stringify({ files: [{ path: 'src/w.mjs', content: 'export const a=1;' }] })]),
      scratch,
    });

    const frozen = await compiler.compile(
      RunConfig.parse({ goal: 'build the widget', verifier: { kind: 'generate' } }),
    );

    expect(frozen.contractHash).toBe(contract.contractHash);
    expect(scratch.destroyed).toBe(1);
  });

  it('realExec propagates the flag `runProcess` sets (the layer that dropped it)', async () => {
    // 17 MB > the 16 MB default cap, so runProcess kills the child mid-stream and flags it.
    const r: ExecResult = await realExec(
      "head -c 17000000 /dev/zero | tr '\\0' 'a'",
      [],
      { cwd: process.cwd(), shell: true, timeoutMs: 120_000 },
    );
    expect(r.timedOut).not.toBe(true);
    expect(r.outputCapped).toBe(true);
  }, 120_000);
});
