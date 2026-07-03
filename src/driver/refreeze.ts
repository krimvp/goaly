import type { CompiledContract, GeneratedFile, Rung } from '../domain/contract';
import type { UnhashedContract } from '../domain/contract';
import type { SealEditPatch } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';
import { freezeContract, sha256Hex } from '../util/hash';

/**
 * The manual-edit refreeze (ADR 0016): performed by the Driver when the operator answers the Seal
 * with `edited`. Re-reads the contract's authored verification files from the workspace (their
 * on-disk content is the operator's edit), re-pins each `sha256`, applies the operator's field
 * patch, and re-freezes a NEW contract (new `contractHash`) — which the Driver returns as a normal
 * `CONTRACT_COMPILED` so it is write-ahead logged and re-presented at Seal. No LLM is involved.
 *
 * Fail-closed throughout (invariant #4): a missing/unreadable/out-of-root authored file or an
 * invalid patch becomes a typed `{ok:false, reason}` (the Driver maps it to `COMPILE_FAILED`),
 * never a silently-unchanged or partially-patched contract.
 */
export type RefreezeResult =
  | { ok: true; contract: CompiledContract }
  | { ok: false; reason: string };

export async function performRefreeze(
  workspace: Pick<Workspace, 'readFile'>,
  contract: CompiledContract,
  patch: SealEditPatch | undefined,
): Promise<RefreezeResult> {
  // Re-pin every authored file from its CURRENT on-disk content (the operator's edit).
  const generatedFiles: GeneratedFile[] = [];
  for (const file of contract.generatedFiles) {
    const content = await workspace.readFile(file.path);
    if (content === null) {
      return {
        ok: false,
        reason: `refreeze failed: authored verification file is missing or unreadable: ${file.path}`,
      };
    }
    generatedFiles.push({ path: file.path, sha256: sha256Hex(content) });
  }

  const { contractHash: _oldHash, ...unhashed } = contract;
  const patched = applySealEditPatch({ ...unhashed, generatedFiles }, patch);
  if (!patched.ok) return patched;
  try {
    return { ok: true, contract: freezeContract(patched.contract) };
  } catch (e) {
    return { ok: false, reason: `refreeze failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Apply the operator's field edits to an unhashed contract — pure, total, fail-closed. `setup:
 * null` clears the setup command (the key is dropped, respecting exactOptionalPropertyTypes);
 * `commands` entries must index an EXISTING deterministic rung (an out-of-range index or a judge
 * rung refuses the whole patch — never a silent partial apply).
 */
export function applySealEditPatch(
  contract: UnhashedContract,
  patch: SealEditPatch | undefined,
): { ok: true; contract: UnhashedContract } | { ok: false; reason: string } {
  if (patch === undefined) return { ok: true, contract };

  let rungs: Rung[] = [...(contract.rungs ?? [])];
  for (const edit of patch.commands ?? []) {
    const rung = rungs[edit.index];
    if (rung === undefined) {
      return { ok: false, reason: `refreeze failed: patch rung index ${edit.index} is out of range` };
    }
    if (rung.kind !== 'deterministic') {
      return {
        ok: false,
        reason: `refreeze failed: patch rung index ${edit.index} is not a deterministic rung`,
      };
    }
    rungs[edit.index] = { ...rung, command: edit.command };
  }

  const { setup: currentSetup, ...rest } = contract;
  const setup =
    patch.setup === undefined ? currentSetup : patch.setup === null ? undefined : patch.setup;
  return {
    ok: true,
    contract: {
      ...rest,
      rungs,
      ...(setup !== undefined ? { setup } : {}),
      ...(patch.rubric !== undefined ? { rubric: patch.rubric } : {}),
    },
  };
}
