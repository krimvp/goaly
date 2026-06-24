import { createHash } from 'node:crypto';
import {
  CompiledContract,
  canonicalContractString,
  type UnhashedContract,
} from '../domain/contract';
import { PhasePlan, canonicalPlanString, type UnhashedPlan } from '../domain/plan';
import { asContractHash, asPlanHash, type ContractHash, type PlanHash } from '../domain/ids';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic content hash of a contract's frozen, bar-defining content. */
export function hashContract(c: UnhashedContract): ContractHash {
  return asContractHash(sha256Hex(canonicalContractString(c)));
}

/**
 * Freeze an unhashed contract: compute its hash and parse the whole thing through the
 * schema so what leaves here is guaranteed valid and immutable in shape.
 */
export function freezeContract(c: UnhashedContract): CompiledContract {
  return CompiledContract.parse({ ...c, contractHash: hashContract(c) });
}

/** Deterministic content hash of a plan's ordered sub-goals (issue #48). */
export function hashPlan(p: UnhashedPlan): PlanHash {
  return asPlanHash(sha256Hex(canonicalPlanString(p)));
}

/**
 * Freeze an unhashed plan: compute its hash and parse the whole thing through the schema so what
 * leaves here is guaranteed valid and immutable in shape — the plan-level analogue of
 * {@link freezeContract}.
 */
export function freezePlan(p: UnhashedPlan): PhasePlan {
  return PhasePlan.parse({ ...p, planHash: hashPlan(p) });
}
