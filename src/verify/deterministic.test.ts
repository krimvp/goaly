import { describe, it, expect } from 'vitest';
import { DeterministicVerifier } from './deterministic';
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
});
