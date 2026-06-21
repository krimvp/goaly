import { describe, it, expect } from 'vitest';
import { makeFakeContract } from '../testing/fakes';
import { AutoContractGate, HumanContractGate } from './gates';

describe('AutoContractGate', () => {
  it('approves and loudly logs the contractHash', async () => {
    // Arrange
    const logs: string[] = [];
    const gate = new AutoContractGate({ log: (msg) => logs.push(msg) });
    const contract = makeFakeContract();

    // Act
    const decision = await gate.approveContract(contract);

    // Assert
    expect(decision).toEqual({ approved: true });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(contract.contractHash);
    expect(logs[0]).toContain(contract.goal);
  });
});

describe('HumanContractGate', () => {
  it('approves when the human answers "y"', async () => {
    // Arrange
    const asked: string[] = [];
    const gate = new HumanContractGate({
      ask: async (q) => {
        asked.push(q);
        return 'y';
      },
      out: () => {},
    });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision).toEqual({ approved: true });
    expect(asked[0]).toContain('Approve this success contract?');
  });

  it('approves on case-insensitive "YES" with whitespace', async () => {
    // Arrange
    const gate = new HumanContractGate({ ask: async () => '  YES \n', out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision.approved).toBe(true);
  });

  it('rejects with a reason when the human answers "n"', async () => {
    // Arrange
    const gate = new HumanContractGate({ ask: async () => 'n', out: () => {} });

    // Act
    const decision = await gate.approveContract(makeFakeContract());

    // Assert
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBeDefined();
    expect(decision.reason?.length ?? 0).toBeGreaterThan(0);
  });

  it('prints the full contract before asking', async () => {
    // Arrange
    const out: string[] = [];
    const gate = new HumanContractGate({
      ask: async () => 'n',
      out: (msg) => out.push(msg),
    });
    const contract = makeFakeContract();

    // Act
    await gate.approveContract(contract);

    // Assert
    expect(out.join('\n')).toContain(contract.contractHash);
  });
});
