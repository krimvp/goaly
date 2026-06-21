import type { CompiledContract } from '../domain/contract';
import type { GateDecision } from '../domain/verdict';

/**
 * Gate A — the contract gate. The `--autonomous` flag moves ONLY this gate:
 *  - default: a human approves the frozen contract once before the loop starts.
 *  - autonomous: auto-accept, but persist the full contract to the run log LOUDLY.
 *
 * Autonomous skips the human *pause*, never the *freeze*.
 */
export interface ContractGate {
  approveContract(contract: CompiledContract): Promise<GateDecision>;
}
