import { describe, it, expect } from 'vitest';
import { FakeWorkspace, makeFakeContract } from '../testing/fakes';
import { AutoSealGate, HumanSealGate } from './seal-gates';
import { buildLadder } from '../cli/compose';
import { FakeLlm } from '../llm/provider';
import { sha256Hex } from '../util/hash';
import type { CompiledContract } from '../domain/contract';

/** The banner's rung lines (`  [n] …`), in order — what the operator counts at SEAL. */
function rungLines(banner: string): string[] {
  return banner.split('\n').filter((line) => /^ {2}\[\d+] /.test(line));
}

/** Render the banner an autonomous Seal would print for `contract`. */
async function banner(contract: CompiledContract): Promise<string> {
  const logs: string[] = [];
  await new AutoSealGate({ log: (msg) => logs.push(msg) }).approveContract(contract);
  return logs.join('\n');
}

/** A scripted `ask` that returns the queued answers in order. */
function scriptedAsk(answers: string[]): {
  ask: (q: string) => Promise<string>;
  asked: string[];
} {
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    ask: async (q) => {
      asked.push(q);
      return answers[i++] ?? '';
    },
  };
}

describe('AutoSealGate', () => {
  it('approves and loudly logs the contractHash', async () => {
    // Arrange
    const logs: string[] = [];
    const gate = new AutoSealGate({ log: (msg) => logs.push(msg) });
    const contract = makeFakeContract();

    // Act
    const decision = await gate.approveContract(contract);

    // Assert
    expect(decision).toEqual({ kind: 'approve' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(contract.contractHash);
    expect(logs[0]).toContain(contract.goal);
  });
});

describe('HumanSealGate', () => {
  it('approves when the human answers "a"', async () => {
    // Arrange
    const { ask, asked } = scriptedAsk(['a']);
    const gate = new HumanSealGate({ ask, out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision).toEqual({ kind: 'approve' });
    expect(asked[0]).toContain('[a]pprove');
  });

  it('"e"/"edited" answer the gate with the manual-edit refreeze decision (ADR 0016)', async () => {
    for (const answer of ['e', 'edited', ' E ']) {
      const gate = new HumanSealGate({ ask: async () => answer, out: () => {} });
      expect(await gate.approveContract(makeFakeContract())).toEqual({ kind: 'edited' });
    }
    // Offered in the prompt so the operator can discover it.
    const { ask, asked } = scriptedAsk(['a']);
    await new HumanSealGate({ ask, out: () => {} }).approveContract(makeFakeContract());
    expect(asked[0]).toContain('[e]dited');
  });

  it('"e" works even when revise is disabled (edited never consumes the revise cap)', async () => {
    const { ask, asked } = scriptedAsk(['e']);
    const gate = new HumanSealGate({ ask, out: () => {}, allowRevise: false });
    expect(await gate.approveContract(makeFakeContract())).toEqual({ kind: 'edited' });
    expect(asked[0]).toContain('[e]dited');
  });

  it('still treats legacy "YES" (any case/whitespace) as approve', async () => {
    // Arrange
    const gate = new HumanSealGate({ ask: async () => '  YES \n', out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision.kind).toBe('approve');
  });

  it('rejects with a reason when the human answers "r"', async () => {
    // Arrange
    const gate = new HumanSealGate({ ask: async () => 'r', out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it('collects free-text feedback on "f" and returns a revise decision', async () => {
    // Arrange
    const { ask, asked } = scriptedAsk(['f', 'use vitest, not a bare assert script']);
    const gate = new HumanSealGate({ ask, out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision).toEqual({
      kind: 'revise',
      feedback: 'use vitest, not a bare assert script',
    });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('change');
  });

  it('fails closed to reject when revise feedback is empty', async () => {
    // Arrange
    const gate = new HumanSealGate({ ask: scriptedAsk(['f', '   ']).ask, out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision.kind).toBe('reject');
  });

  it('when revise is disabled, shows the binary prompt and never revises', async () => {
    // Arrange
    const { ask, asked } = scriptedAsk(['f']);
    const gate = new HumanSealGate({ ask, out: () => {}, allowRevise: false });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert — "f" is not an approve token, so it rejects; only one question is asked.
    expect(decision.kind).toBe('reject');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('[y]es');
  });

  it('prints the full contract before asking', async () => {
    // Arrange
    const out: string[] = [];
    const gate = new HumanSealGate({ ask: async () => 'r', out: (msg) => out.push(msg) });
    const contract = makeFakeContract();

    // Act
    await gate.approveContract(contract);

    // Assert
    expect(out.join('\n')).toContain(contract.contractHash);
  });
});

describe('the SEAL contract banner', () => {
  const RUBRIC = 'the parser must reject malformed input';
  const AUTHORED = 'parser.test.ts';
  const AUTHORED_SHA = sha256Hex('expect(parse("x")).toThrow()');

  /** A contract with authored verification files — the shape that gets a guard rung (issue #120). */
  function authoredContract(): CompiledContract {
    return makeFakeContract({
      rungs: [
        { kind: 'deterministic', command: 'npm test' },
        { kind: 'judge', rubric: RUBRIC, quorum: 3, confidenceFloor: 0.66 },
      ],
      rubric: RUBRIC,
      generatedFiles: [{ path: AUTHORED, sha256: AUTHORED_SHA }],
    });
  }

  it('prints as many rungs as the ladder reports in rungsTotal when files are authored', async () => {
    // Arrange — the guard the ladder prepends must be visible, or the banner undercounts.
    const contract = authoredContract();
    const workspace = new FakeWorkspace();
    workspace.setFileHash(AUTHORED, AUTHORED_SHA);

    // Act
    const printed = rungLines(await banner(contract));
    const verdict = await buildLadder(contract, new FakeLlm([])).verify(
      workspace,
      contract.goal,
      contract.rubric,
    );

    // Assert
    expect(verdict.rungsTotal).toBe(printed.length);
    expect(printed).toHaveLength(3);
    expect(printed[0]).toContain('[0]');
    expect(printed[0]).toContain('generated-files');
    expect(printed[1]).toContain('[1] deterministic: npm test');
    expect(printed[2]).toContain('[2] judge');
  });

  it('reconciles for a plain --verify-cmd contract (no authored files ⇒ no guard rung)', async () => {
    // Arrange
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: '',
      generatedFiles: [],
    });

    // Act
    const printed = rungLines(await banner(contract));
    const verdict = await buildLadder(contract, new FakeLlm([])).verify(
      new FakeWorkspace('0000000', '', [{ exitCode: 0, stdout: '', stderr: '' }]),
      contract.goal,
      contract.rubric,
    );

    // Assert
    expect(printed).toHaveLength(1);
    expect(verdict.rungsTotal).toBe(1);
    expect(printed[0]).toContain('[0] deterministic: npm test');
  });

  it('still reconciles when the guard reds the ladder (guard runs and fails closed)', async () => {
    // Arrange — the authored file was tampered with since the freeze.
    const contract = authoredContract();
    const workspace = new FakeWorkspace();
    workspace.setFileHash(AUTHORED, sha256Hex('assert(true)'));

    // Act
    const printed = rungLines(await banner(contract));
    const verdict = await buildLadder(contract, new FakeLlm([])).verify(
      workspace,
      contract.goal,
      contract.rubric,
    );

    // Assert — a red at the FIRST printed rung, not at an invisible one.
    expect(verdict.pass).toBe(false);
    expect(verdict.rungsPassed).toBe(0);
    expect(verdict.rungsTotal).toBe(printed.length);
  });

  it('prints the rubric exactly once', async () => {
    // Arrange
    const contract = authoredContract();

    // Act
    const text = await banner(contract);

    // Assert
    expect(text.split(RUBRIC)).toHaveLength(2);
    expect(text).toContain('rubric:');
  });

  it('spells out a judge rung whose rubric differs from the contract rubric', async () => {
    // Arrange — the schema allows a rung-specific rubric; it must not be silently collapsed.
    const contract = makeFakeContract({
      rungs: [{ kind: 'judge', rubric: 'rung-specific bar', quorum: 1, confidenceFloor: 0.5 }],
      rubric: RUBRIC,
      generatedFiles: [],
    });

    // Act
    const text = await banner(contract);

    // Assert
    expect(text).toContain('rung-specific bar');
    expect(text).toContain(RUBRIC);
  });
});
