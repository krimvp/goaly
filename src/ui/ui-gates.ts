import { randomUUID } from 'node:crypto';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { SealDecision } from '../domain/verdict';
import type { SealGate } from '../compile/seal';
import type { PlanGate } from '../plan/plan-gate';
import type { PendingGate } from './api-schema';

/**
 * The browser Seal / plan-Seal gate (ADR 0015): a third {@link SealGate}/{@link PlanGate}
 * IMPLEMENTATION — never a bypass. `approveContract`/`approvePlan` PARK the contract/plan in
 * server memory under a fresh `gateId` and await the HTTP decision; the contract still freezes and
 * `SEAL_DECIDED` still logs exactly as with the CLI prompt (invariant #5), and `--autonomous`
 * semantics are untouched (an autonomous UI run composes the AutoSealGate as always).
 *
 * Fail-closed rules mirror `HumanSealGate`: a `revise` REQUIRES non-empty feedback (enforced by
 * the request schema), a stale/unknown `gateId` is refused (double-submit guard), and `stop()`
 * resolves any parked gate to reject so `drive()` unwinds cleanly — the between-steps interrupt
 * probe alone can never wake a parked gate.
 */
export class UiGates implements SealGate, PlanGate {
  #pending: { gate: PendingGate; resolve: (d: SealDecision) => void } | undefined;
  readonly #listeners = new Set<(gate: PendingGate | { resolved: string }) => void>();
  #stopped = false;

  approveContract(contract: CompiledContract): Promise<SealDecision> {
    return this.#park({ gateId: randomUUID(), kind: 'seal', contract });
  }

  approvePlan(plan: PhasePlan): Promise<SealDecision> {
    return this.#park({ gateId: randomUUID(), kind: 'plan', plan });
  }

  /** The currently parked gate, if any (the poll-fallback route + reconnecting SSE clients). */
  pending(): PendingGate | undefined {
    return this.#pending?.gate;
  }

  /**
   * Answer the parked gate.
   *  - `'stale'`: no parked gate, or the id names a superseded one — the HTTP layer maps it to
   *    409 so a double-submit can never answer a LATER gate.
   *  - `'invalid'`: an `edited` decision against a parked PLAN gate — manual editing applies to
   *    contract artifacts only (ADR 0016); plans change through revise. Mapped to 400.
   */
  resolve(gateId: string, decision: SealDecision): 'ok' | 'stale' | 'invalid' {
    const pending = this.#pending;
    if (pending === undefined || pending.gate.gateId !== gateId) return 'stale';
    if (decision.kind === 'edited' && pending.gate.kind === 'plan') return 'invalid';
    this.#pending = undefined;
    pending.resolve(decision);
    this.#notify({ resolved: gateId });
    return 'ok';
  }

  /** Reject any parked gate (the stop path) — a parked run must unwind, not hang forever. */
  stop(): void {
    this.#stopped = true;
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#pending = undefined;
      pending.resolve({ kind: 'reject', reason: 'stopped from goaly ui' });
      this.#notify({ resolved: pending.gate.gateId });
    }
  }

  /** Subscribe to gate lifecycle (the SSE push channel). Returns an unsubscribe function. */
  onGateEvent(listener: (event: PendingGate | { resolved: string }) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #park(gate: PendingGate): Promise<SealDecision> {
    if (this.#stopped) {
      // The run was stopped while compiling — never park a gate nobody can answer.
      return Promise.resolve({ kind: 'reject', reason: 'stopped from goaly ui' });
    }
    if (this.#pending !== undefined) {
      // Two parked gates can't coexist in one run (the reducer awaits each Seal serially); if it
      // ever happened it would be a bug — fail the NEW one closed rather than orphan the old.
      return Promise.resolve({ kind: 'reject', reason: 'internal: a gate is already pending' });
    }
    return new Promise<SealDecision>((resolve) => {
      this.#pending = { gate, resolve };
      this.#notify(gate);
    });
  }

  #notify(event: PendingGate | { resolved: string }): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* a bad subscriber must never break the gate */
      }
    }
  }
}
