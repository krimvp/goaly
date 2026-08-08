import { z } from 'zod';
import { UsageError, str, type RawFlags } from './tokens';

/**
 * Validate `--approver-quorum N` at the seam (issue #84): a positive integer reviewer count for the
 * Sign-off panel, fail-closed on anything else (invariant #6). Absent ⇒ undefined so the
 * approver-block default (1 ⇒ the single-call approver) applies.
 */
export function parseApproverQuorum(flags: RawFlags): number | undefined {
  const v = str(flags, 'approver-quorum');
  if (v === undefined) return undefined;
  const parsed = z.coerce.number().int().positive().safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--approver-quorum: expected a positive integer, got '${v}'`);
  }
  return parsed.data;
}

/**
 * Validate the `--adversarial-*` panel-size flags at the seam: a NON-NEGATIVE integer (0 is a valid
 * "skip this step" opt-out), fail-closed on anything else (invariant #6). Absent ⇒ undefined so the
 * adversarial-block defaults apply.
 */
export function parseAdversarialCount(flags: RawFlags, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const parsed = z.coerce.number().int().min(0).safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--${name}: expected a non-negative integer, got '${v}'`);
  }
  return parsed.data;
}

/**
 * Validate `--approver-diversity-temp T` at the seam (issue #84): a sampling temperature in [0,2]
 * applied ONLY when the panel has `quorum > 1`, fail-closed on anything else. Absent ⇒ undefined so
 * the approver-block default (0.5) applies.
 */
export function parseApproverDiversityTemp(flags: RawFlags): number | undefined {
  const v = str(flags, 'approver-diversity-temp');
  if (v === undefined) return undefined;
  const parsed = z.coerce.number().min(0).max(2).safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--approver-diversity-temp: expected a number in [0,2], got '${v}'`);
  }
  return parsed.data;
}

/**
 * Validate `--approver-lenses l1,l2,…` at the seam (issue #84 OQ4): a comma-separated LIST of
 * operator-supplied review lenses, each trimmed + non-empty, fail-closed on an empty entry / empty
 * list (invariant #6). Mirrors `--approver-models` exactly — splitting here just normalizes the wire
 * form; the Zod array seam (`.nonempty()`, `.min(1)` per entry) is the real fail-closed gate. Absent
 * ⇒ undefined so the approver keeps the default lens taxonomy (byte-for-byte unchanged).
 */
export function parseApproverLenses(flags: RawFlags): [string, ...string[]] | undefined {
  const v = str(flags, 'approver-lenses');
  if (v === undefined) return undefined;
  const entries = v.split(',').map((l) => l.trim());
  const parsed = z.array(z.string().min(1)).nonempty().safeParse(entries);
  if (!parsed.success) {
    throw new UsageError(
      `--approver-lenses: expected a comma-separated list of non-empty lenses, got '${v}'`,
    );
  }
  return parsed.data;
}
