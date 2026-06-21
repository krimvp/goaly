import { describe, it, expect } from 'vitest';
import { makeFakeContract } from '../testing/fakes';
import { AutoContractGate, HumanContractGate } from './gates';

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

describe('AutoContractGate', () => {
  it('approves and loudly logs the contractHash', async () => {
    // Arrange
    const logs: string[] = [];
    const gate = new AutoContractGate({ log: (msg) => logs.push(msg) });
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

describe('HumanContractGate', () => {
  it('approves when the human answers "a"', async () => {
    // Arrange
    const { ask, asked } = scriptedAsk(['a']);
    const gate = new HumanContractGate({ ask, out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision).toEqual({ kind: 'approve' });
    expect(asked[0]).toContain('[a]pprove');
  });

  it('still treats legacy "YES" (any case/whitespace) as approve', async () => {
    // Arrange
    const gate = new HumanContractGate({ ask: async () => '  YES \n', out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision.kind).toBe('approve');
  });

  it('rejects with a reason when the human answers "r"', async () => {
    // Arrange
    const gate = new HumanContractGate({ ask: async () => 'r', out: () => {} });

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
    const gate = new HumanContractGate({ ask, out: () => {} });

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
    const gate = new HumanContractGate({ ask: scriptedAsk(['f', '   ']).ask, out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision.kind).toBe('reject');
  });

  it('when revise is disabled, shows the binary prompt and never revises', async () => {
    // Arrange
    const { ask, asked } = scriptedAsk(['f']);
    const gate = new HumanContractGate({ ask, out: () => {}, allowRevise: false });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert — "f" is not an approve token, so it rejects; only one question is asked.
    expect(decision.kind).toBe('reject');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('[y/N]');
  });

  it('prints the full contract before asking', async () => {
    // Arrange
    const out: string[] = [];
    const gate = new HumanContractGate({ ask: async () => 'r', out: (msg) => out.push(msg) });
    const contract = makeFakeContract();

    // Act
    await gate.approveContract(contract);

    // Assert
    expect(out.join('\n')).toContain(contract.contractHash);
  });
});
