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
    async readFile() {
        return null;
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

  describe('could-not-evaluate classification — only on facts goaly OWNS (no heuristics)', () => {
    it('flags a timed-out command (goaly killed it) as unevaluable, not a genuine red', async () => {
      const workspace = new FakeWorkspace('0000000', '', [
        { exitCode: 124, stdout: '', stderr: '[goaly] command timed out after 1000ms', timedOut: true },
      ]);
      const verdict = await new DeterministicVerifier('npm test').verify(workspace, 'g', 'r');

      expect(verdict.pass).toBe(false); // still fail-closed
      expect(verdict.evaluable).toBe(false); // but a could-not-evaluate, not "your code is wrong"
      expect(verdict.detail).toContain('timed out');
    });

    it('flags a spawn failure (goaly could not start the command) as unevaluable', async () => {
      const workspace = new FakeWorkspace('0000000', '', [
        { exitCode: 127, stdout: '', stderr: 'spawn sh ENOENT', spawnFailed: true },
      ]);
      const verdict = await new DeterministicVerifier('npm test').verify(workspace, 'g', 'r');

      expect(verdict.pass).toBe(false);
      expect(verdict.evaluable).toBe(false);
      expect(verdict.detail).toContain('could not be started');
    });

    it('does NOT guess from the exit code or output — a bare exit 127 stays a genuine red', async () => {
      // A command that RAN and exited 127 (e.g. a missing sub-command inside a test script) is a real
      // red, not a could-not-evaluate. Missing TOOLCHAIN is caught earlier by the requiredTools
      // pre-flight; we deliberately do not re-derive "couldn't run" from the exit code here.
      const workspace = new FakeWorkspace('0000000', '', [
        { exitCode: 127, stdout: '', stderr: 'foo: command not found' },
      ]);
      const verdict = await new DeterministicVerifier('npm test').verify(workspace, 'g', 'r');

      expect(verdict.pass).toBe(false);
      expect(verdict.evaluable).toBeUndefined();
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

  describe('executionErrorReason (pure classifier — owned facts only)', () => {
    it('returns a reason for a timeout and for a spawn failure', () => {
      expect(executionErrorReason({ exitCode: 124, stdout: '', stderr: '', timedOut: true })).not.toBeNull();
      expect(executionErrorReason({ exitCode: 127, stdout: '', stderr: '', spawnFailed: true })).not.toBeNull();
    });

    it('returns null for any plain non-zero exit, regardless of exit code or output', () => {
      expect(executionErrorReason({ exitCode: 1, stdout: '', stderr: 'AssertionError' })).toBeNull();
      // No heuristics: a network-looking error or a 127 with no owned flag is NOT reclassified.
      expect(
        executionErrorReason({ exitCode: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org' }),
      ).toBeNull();
      expect(executionErrorReason({ exitCode: 127, stdout: '', stderr: 'vitest: not found' })).toBeNull();
    });
  });
});
