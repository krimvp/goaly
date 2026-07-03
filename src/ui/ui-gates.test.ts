import { describe, it, expect } from 'vitest';
import { UiGates } from './ui-gates';
import { makeFakeContract } from '../testing/fakes';

describe('UiGates — the browser Seal / plan-Seal gate (ADR 0015)', () => {
  it('parks the contract, exposes it as pending, and resolves the decision by gateId', async () => {
    const gates = new UiGates();
    const contract = makeFakeContract();
    const decision = gates.approveContract(contract);
    const pending = gates.pending();
    expect(pending).toMatchObject({ kind: 'seal' });
    expect(pending?.kind === 'seal' ? pending.contract.contractHash : undefined).toBe(
      contract.contractHash,
    );

    expect(gates.resolve(pending!.gateId, { kind: 'approve' })).toBe('ok');
    await expect(decision).resolves.toEqual({ kind: 'approve' });
    expect(gates.pending()).toBeUndefined();
  });

  it('refuses a stale/unknown gateId (double-submit guard) — false, never a resolved later gate', async () => {
    const gates = new UiGates();
    const first = gates.approveContract(makeFakeContract());
    const firstId = gates.pending()!.gateId;
    expect(gates.resolve('not-the-id', { kind: 'approve' })).toBe('stale');
    expect(gates.resolve(firstId, { kind: 'revise', feedback: 'tighten the bar' })).toBe('ok');
    await expect(first).resolves.toEqual({ kind: 'revise', feedback: 'tighten the bar' });

    // The next (re-authored) contract parks under a FRESH id; the old id cannot answer it.
    const second = gates.approveContract(makeFakeContract({ goal: 'v2' }));
    expect(gates.pending()!.gateId).not.toBe(firstId);
    expect(gates.resolve(firstId, { kind: 'approve' })).toBe('stale');
    gates.resolve(gates.pending()!.gateId, { kind: 'reject', reason: 'no' });
    await expect(second).resolves.toMatchObject({ kind: 'reject' });
  });

  it('stop() rejects a parked gate so drive() unwinds, and pre-empts future parks', async () => {
    const gates = new UiGates();
    const parked = gates.approveContract(makeFakeContract());
    gates.stop();
    await expect(parked).resolves.toMatchObject({ kind: 'reject', reason: expect.stringContaining('stopped') });
    // A gate parked AFTER stop resolves immediately to reject — never an unanswerable hang.
    await expect(gates.approveContract(makeFakeContract())).resolves.toMatchObject({ kind: 'reject' });
  });

  it("resolves 'edited' on a seal gate; refuses it on a plan gate as 'invalid' (ADR 0016)", async () => {
    const gates = new UiGates();
    const sealDecision = gates.approveContract(makeFakeContract());
    const sealId = gates.pending()!.gateId;
    expect(gates.resolve(sealId, { kind: 'edited' })).toBe('ok');
    await expect(sealDecision).resolves.toEqual({ kind: 'edited' });

    const planDecision = gates.approvePlan({ phases: [{ goal: 'p1' }], planHash: 'p'.repeat(64) } as never);
    const planId = gates.pending()!.gateId;
    expect(gates.resolve(planId, { kind: 'edited' })).toBe('invalid');
    expect(gates.pending()?.gateId).toBe(planId); // still parked — the refusal resolved nothing
    gates.resolve(planId, { kind: 'approve' });
    await expect(planDecision).resolves.toEqual({ kind: 'approve' });
  });

  it('notifies gate listeners on park and on resolve (the SSE push channel)', async () => {
    const gates = new UiGates();
    const events: Array<string> = [];
    const unsubscribe = gates.onGateEvent((e) => events.push('resolved' in e ? `resolved:${e.resolved}` : `gate:${e.kind}`));
    const decision = gates.approveContract(makeFakeContract());
    const id = gates.pending()!.gateId;
    gates.resolve(id, { kind: 'approve' });
    await decision;
    expect(events).toEqual(['gate:seal', `resolved:${id}`]);
    unsubscribe();
  });
});
