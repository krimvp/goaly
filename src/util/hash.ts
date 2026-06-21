import { createHash } from 'node:crypto';
import {
  CompiledContract,
  canonicalContractString,
  type UnhashedContract,
} from '../domain/contract';
import { asContractHash, type ContractHash } from '../domain/ids';

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
