import type { ContractInput } from '../domain/config';
import type { CompiledContract } from '../domain/contract';

/**
 * Phase 1 — compile the verifier (fuzzy, agent-driven). Either finds the existing
 * tests/commands the user pointed at, or authors new ones, then emits a concrete runnable
 * contract (ladder + rubric). The result is FROZEN by the caller (its `contractHash` set
 * once) — the central anti-reward-hacking invariant. May throw; the Driver turns a thrown
 * error into a `COMPILE_FAILED` event.
 *
 * `feedback` carries the human's free-text note from a Seal "revise" round: when present,
 * an authoring compiler should re-author the contract steered by it. This is pre-approval
 * renegotiation and does not weaken the freeze — each attempt is frozen and logged on its
 * own; only the approved contract enters the loop.
 *
 * The input is narrowed to {@link ContractInput} (goal / verification intent / judge bar): the
 * compiler authors the FROZEN contract and so must NOT read loop, gate, or wiring config — the type
 * makes that structural, not a convention. The Driver still passes the whole `RunConfig` (a superset).
 */
export interface VerifierCompiler {
  compile(input: ContractInput, feedback?: string): Promise<CompiledContract>;
}
