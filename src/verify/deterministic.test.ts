import { describe, it, expect } from 'vitest';
import { DeterministicVerifier, executionErrorReason } from './deterministic';
import { FakeWorkspace } from '../testing/fakes';
import type { Workspace, CommandResult } from '../workspace/workspace';
import { DiffHash } from '../domain/ids';

/** A workspace that records every `run` call (command + opts) so we can assert what was forwarded. */
function spyWorkspace(result: CommandResult): {
  workspace: Workspace;
  calls: Array<{ command: string; opts?: { timeoutMs?: number } }>;
} {
  const calls: Array<{ command: string; opts?: { timeoutMs?: number } }> = [];
  const workspace: Workspace = {
    async diffHash() {
      return DiffHash.parse('0'.repeat(40));
    },
    async diff() {
      return '';
    },
    async checkpoint() {
      return DiffHash.parse('0'.repeat(40));
    },
    setBaseline() {},
    setDiffIncludes() {},
    currentBaseline() {
      return 'HEAD';
    },
    async run(command, opts) {
      calls.push(opts !== undefined ? { command, opts } : { command });
      return result;
    },
    async fileHash() {
      return null;
    },
    async isEmptyOfSource() {
      return false;
    },
  };
  return { workspace, calls };
}

describe('DeterministicVerifier', () => {
  it('passes with confidence 1 when the command exits 0', async () => {
    // Arrange
    const workspace = new FakeWorkspace('0000000', '', [
      { exitCode: 0, stdout: 'ok', stderr: '' },
    ]);
    const verifier = new DeterministicVerifier('npm test');

    // Act
    const verdict = await verifier.verify(workspace, 'goal', 'rubric');

    // Assert
    expect(verdict.pass).toBe(true);
    expect(verdict.confidence).toBe(1);
    expect(verdict.detail).toBe('npm test: exit 0');
  });

  it('fails when the command exits non-zero and surfaces stderr in the detail', async () => {
    // Arrange
    const workspace = new FakeWorkspace('0000000', '', [
      { exitCode: 1, stdout: '', stderr: 'boom: assertion failed' },
    ]);
    const verifier = new DeterministicVerifier('npm test');

    // Act
    const verdict = await verifier.verify(workspace, 'goal', 'rubric');

    // Assert
    expect(verdict.pass).toBe(false);
    expect(verdict.confidence).toBe(1);
    expect(verdict.detail).toContain('exit 1');
    expect(verdict.detail).toContain('boom: assertion failed');
  });

  it('uses the label instead of the command in the detail when provided', async () => {
    // Arrange
    const workspace = new FakeWorkspace('0000000', '', [
      { exitCode: 0, stdout: '', stderr: '' },
    ]);
    const verifier = new DeterministicVerifier('npm run test:unit', 'unit tests');

    // Act
    const verdict = await verifier.verify(workspace, 'goal', 'rubric');

    // Assert
    expect(verdict.detail).toBe('unit tests: exit 0');
  });

  it('falls back to stdout when stderr is empty on failure', async () => {
    // Arrange
    const workspace = new FakeWorkspace('0000000', '', [
      { exitCode: 2, stdout: 'failure on stdout', stderr: '' },
    ]);
    const verifier = new DeterministicVerifier('lint', 'lint');

    // Act
    const verdict = await verifier.verify(workspace, 'goal', 'rubric');

    // Assert
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain('exit 2');
    expect(verdict.detail).toContain('failure on stdout');
  });

  it('forwards an explicit timeout to workspace.run', async () => {
    const { workspace, calls } = spyWorkspace({ exitCode: 0, stdout: '', stderr: '' });
    const verifier = new DeterministicVerifier('npm test', undefined, 30000);

    await verifier.verify(workspace, 'goal', 'rubric');

    expect(calls).toEqual([{ command: 'npm test', opts: { timeoutMs: 30000 } }]);
  });

  it('passes no opts when no timeout is configured', async () => {
    const { workspace, calls } = spyWorkspace({ exitCode: 0, stdout: '', stderr: '' });
    const verifier = new DeterministicVerifier('npm test');

    await verifier.verify(workspace, 'goal', 'rubric');

    expect(calls).toEqual([{ command: 'npm test' }]);
  });

  it('truncates long failure output to 2000 chars', async () => {
    // Arrange
    const long = 'x'.repeat(5000);
    const workspace = new FakeWorkspace('0000000', '', [
      { exitCode: 1, stdout: '', stderr: long },
    ]);
    const verifier = new DeterministicVerifier('check');

    // Act
    const verdict = await verifier.verify(workspace, 'goal', 'rubric');

    // Assert: prefix "check: exit 1\n" plus 2000 chars of output
    expect(verdict.detail).toBe(`check: exit 1\n${'x'.repeat(2000)}`);
  });

  describe('could-not-evaluate classification (verifier ERROR vs FAIL)', () => {
    it('flags exit 127 (command not found) as unevaluable, not a genuine red', async () => {
      const workspace = new FakeWorkspace('0000000', '', [
        { exitCode: 127, stdout: '', stderr: 'sh: 1: vitest: not found' },
      ]);
      const verdict = await new DeterministicVerifier('vitest run').verify(workspace, 'g', 'r');

      expect(verdict.pass).toBe(false); // still fail-closed
      expect(verdict.evaluable).toBe(false); // but a could-not-run, not "your code is wrong"
      expect(verdict.detail).toContain('could not run');
    });

    it('flags the 124 timeout exit as unevaluable', async () => {
      const workspace = new FakeWorkspace('0000000', '', [
        { exitCode: 124, stdout: '', stderr: '[goaly] command timed out after 1000ms' },
      ]);
      const verdict = await new DeterministicVerifier('npm test').verify(workspace, 'g', 'r');

      expect(verdict.pass).toBe(false);
      expect(verdict.evaluable).toBe(false);
    });

    it('flags a network/package-manager fetch failure (the npx-egress incident) as unevaluable', async () => {
      // The exact case from the run: `npx --yes vitest` fails to resolve behind a restricted proxy,
      // exiting 1 — but the output names a DNS/registry fetch error, so it could-not-RUN, not a red.
      const workspace = new FakeWorkspace('0000000', '', [
        {
          exitCode: 1,
          stdout: '',
          stderr: 'npm error code EAI_AGAIN\nnpm error request to https://registry.npmjs.org failed, reason: getaddrinfo EAI_AGAIN',
        },
      ]);
      const verdict = await new DeterministicVerifier('npx --yes vitest run').verify(workspace, 'g', 'r');

      expect(verdict.pass).toBe(false);
      expect(verdict.evaluable).toBe(false);
    });

    it('does NOT flag a genuine assertion failure as unevaluable (a real red stays a real red)', async () => {
      const workspace = new FakeWorkspace('0000000', '', [
        { exitCode: 1, stdout: '', stderr: 'AssertionError: expected 3 to equal 4\n2 failed | 25 passed' },
      ]);
      const verdict = await new DeterministicVerifier('npm test').verify(workspace, 'g', 'r');

      expect(verdict.pass).toBe(false);
      expect(verdict.evaluable).toBeUndefined(); // omitted ⇒ a normal, evaluable red
    });
  });

  describe('executionErrorReason (pure classifier)', () => {
    it('returns a reason for the structural could-not-run exit codes', () => {
      for (const code of [124, 126, 127, 137, 143]) {
        expect(executionErrorReason(code, '')).not.toBeNull();
      }
    });

    it('returns null for a plain non-zero exit with assertion-failure output', () => {
      expect(executionErrorReason(1, 'AssertionError: expected 3 to equal 4')).toBeNull();
      expect(executionErrorReason(2, 'lint: 5 problems')).toBeNull();
    });

    it('matches conservative infra signatures but not generic transport errors', () => {
      expect(executionErrorReason(1, 'Error: Cannot find module "vitest"')).not.toBeNull();
      expect(executionErrorReason(1, 'getaddrinfo ENOTFOUND registry.npmjs.org')).not.toBeNull();
      expect(executionErrorReason(1, 'No test files found, exiting with code 1')).not.toBeNull();
      // ECONNREFUSED is intentionally NOT a signature — it may be the subject of a real network test.
      expect(executionErrorReason(1, 'expected connect to succeed but got ECONNREFUSED')).toBeNull();
    });
  });
});
