import { z } from 'zod';
import { ContractHash } from './ids';

/**
 * A single rung of the verifier ladder. Ordered cheapest-and-hardest-to-game first:
 * deterministic rungs run before judge rungs, and the ladder short-circuits on the
 * first deterministic failure (no judge call wasted).
 */
export const Rung = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deterministic'),
    /** Shell command; `pass = exitCode === 0`, `confidence = 1`. Ungameable. */
    command: z.string().min(1),
    /** Optional label for logs/feedback. */
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('judge'),
    /** Frozen judging criteria for this rung. */
    rubric: z.string().min(1),
    quorum: z.number().int().min(1),
    confidenceFloor: z.number().min(0).max(1),
    label: z.string().optional(),
  }),
]);
export type Rung = z.infer<typeof Rung>;

/**
 * A verification file the compiler authored, pinned by the sha256 of its content at freeze time
 * Recording only the path let the worker rewrite the file the frozen command runs —
 * keeping `npm test` "frozen" while the bar it measures was rewritten. Pinning the content hash
 * makes that tampering detectable: a guard re-hashes each file before verifying and fails closed
 * if it moved.
 */
export const GeneratedFile = z.object({
  path: z.string().min(1),
  /** sha256 (hex) of the file's content as the compiler wrote it. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type GeneratedFile = z.infer<typeof GeneratedFile>;

/**
 * The compiled, FROZEN success contract. Authored once in the compile phase, approved
 * at Seal, then never rewritten — the central anti-reward-hacking invariant. The
 * `contractHash` is logged every iteration to prove the bar never moved.
 */
export const CompiledContract = z.object({
  goal: z.string().min(1),
  /** The ladder, in execution order. At least one rung. */
  rungs: z.array(Rung).min(1),
  /** The frozen overall rubric (for audit + the approver's Sign-off input). */
  rubric: z.string(),
  /**
   * Files the compiler authored while writing new verification, each pinned by content hash. Part
   * of the frozen bar: a guard rung re-checks them every iteration so the worker can't rewrite the
   * tests the frozen command runs.
   */
  generatedFiles: z.array(GeneratedFile).default([]),
  contractHash: ContractHash,
});
export type CompiledContract = z.infer<typeof CompiledContract>;

/** The contract minus its hash — what the compiler produces before freezing. */
export type UnhashedContract = Omit<z.input<typeof CompiledContract>, 'contractHash'>;

/**
 * Canonical, stable serialization of a contract's *semantic* content (everything that
 * defines the bar), excluding the hash itself. Pure and deterministic: key order is
 * fixed here, never left to `JSON.stringify`'s insertion order. The driver/compiler
 * hash this string; the reducer only ever compares the resulting frozen `contractHash`.
 */
export function canonicalContractString(c: UnhashedContract): string {
  const rungs = c.rungs.map((r) =>
    r.kind === 'deterministic'
      ? { kind: r.kind, command: r.command, label: r.label ?? null }
      : {
          kind: r.kind,
          rubric: r.rubric,
          quorum: r.quorum,
          confidenceFloor: r.confidenceFloor,
          label: r.label ?? null,
        },
  );
  const generatedFiles = [...(c.generatedFiles ?? [])]
    .map((f) => ({ path: f.path, sha256: f.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({
    goal: c.goal,
    rubric: c.rubric,
    rungs,
    generatedFiles,
  });
}
