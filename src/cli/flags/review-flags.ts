import { z } from 'zod';
import { UsageError, str, boolFlag, type RawFlags } from './tokens';

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
 * Parse `--no-satisfiability-critic` (issue #118) — the opt-out for the DEFAULT-ON FALSE-RED
 * satisfiability critic. Returns the critic's ENABLED state, so the flag's presence means `false`;
 * absent ⇒ undefined so the adversarial-block default (`true`) applies. Tri-state via
 * {@link boolFlag} so a `.goalyrc` can persist `"no-satisfiability-critic": false` (i.e. keep the
 * critic on) and a later CLI flag still wins, fail-closed on any other value.
 */
export function parseSatisfiabilityCritic(flags: RawFlags): boolean | undefined {
  const off = boolFlag(flags, 'no-satisfiability-critic');
  return off === undefined ? undefined : !off;
}

/**
 * Parse `--contract-dry-run true|false` (issue #115) — the compile-time POSITIVE control. Tri-state
 * via {@link boolFlag} (a bare `--contract-dry-run` ⇒ on, `--contract-dry-run false` ⇒ off, absent ⇒
 * undefined so the adversarial-block default `true` applies), fail-closed on any other value. It is
 * inert on the `--verify-cmd` path regardless: a user-supplied bar is the user's own.
 */
export function parseContractDryRun(flags: RawFlags): boolean | undefined {
  return boolFlag(flags, 'contract-dry-run');
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
