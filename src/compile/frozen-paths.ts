import { posix } from 'node:path';

/**
 * Path identity for the FROZEN verification files, used by the contract dry run
 * ({@link import('./contract-dry-run').ContractDryRunCompiler}) to decide whether a file the
 * throwaway reference implementation wants to write would land on the bar under test.
 *
 * That is the module's ONLY job. It deliberately does not — and no longer may — look at anything a
 * scratch subprocess printed. Four successive attempts to sanitize a failing rung's stdout/stderr
 * down to "safe" lines were each defeated, because the streams the filter read are the SAME streams
 * the reference implementation writes to: runner text and reference text are interleaved in one
 * adversary-writable channel, so no lexical shape rule can attribute provenance inside it. The
 * refusal now carries no runner output at all (see `contract-dry-run.ts`), and this file is what
 * remains: a predicate over paths goaly itself authored.
 */

/**
 * Canonical comparison form of a workspace-relative path: trimmed, with `.` segments, duplicate
 * separators and a trailing `/`/`/.` collapsed, and any leading `./` (or `../`) resolved away.
 *
 * This is deliberately the SAME collapse `FsScratchCopy.writeFile` gets for free from
 * `resolve(root, relPath)`. When this normalized only a leading `./`, a reference file spelled
 * `verify/./check.test.mjs` was judged UNFROZEN by the collision drop (so it was written) yet landed
 * on the frozen path once resolved — silently rewriting the bar the control was measuring.
 */
export function normalizeRel(p: string): string {
  return posix.normalize(`/${p.trim()}`).replace(/\/+$/, '').slice(1);
}

/**
 * True when `ref` names one of the frozen verification files.
 *
 * The match is on the canonical relative path, or on a path SUFFIX — deliberately BROAD, because the
 * one caller uses it to REFUSE a write. Over-matching drops a reference file that might have been
 * harmless; under-matching would let the reference overwrite the assertions under test, turning a
 * provably unsatisfiable bar into a green. Fail-closed means erring toward the refusal.
 */
export function namesFrozenFile(ref: string, frozen: readonly string[]): boolean {
  const token = normalizeRel(ref);
  return frozen.some((f) => {
    const path = normalizeRel(f);
    if (path.length === 0) return false;
    return token === path || token.endsWith(`/${path}`);
  });
}
