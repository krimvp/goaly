import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';

/**
 * Phase 1 — compile the verifier (fuzzy, agent-driven). Either finds the existing
 * tests/commands the user pointed at, or authors new ones, then emits a concrete runnable
 * contract (ladder + rubric). The result is FROZEN by the caller (its `contractHash` set
 * once) — the central anti-reward-hacking invariant. May throw; the Driver turns a thrown
 * error into a `COMPILE_FAILED` event.
 */
export interface VerifierCompiler {
  compile(config: RunConfig): Promise<CompiledContract>;
}
