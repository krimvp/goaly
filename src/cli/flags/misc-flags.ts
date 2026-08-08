import { z } from 'zod';
import { LogLevel } from '../../log/logger';
import { DEFAULT_MAX_RECONTRACTS } from '../../followup/recontract';
import { str, UsageError, type RawFlags } from './tokens';

/**
 * `--recontract` (issue #117): with `--from-run <runId>`, start a SUCCESSOR run over the predecessor's
 * KEPT tree — re-author the bar its `CONTRACT_DEFECTIVE` adjudication condemned, freeze a NEW contract
 * under a NEW run id, and record the provenance. `--max-recontracts` bounds the chain (default
 * {@link DEFAULT_MAX_RECONTRACTS}); the depth lives in the run log, so the cap holds across the chain
 * rather than per process.
 */
export type RecontractRequest = { readonly maxRecontracts: number };

/**
 * Parse the `--recontract` / `--max-recontracts` pair. Fails closed: a cap without the flag it bounds
 * is a usage error rather than a silently ignored setting. Both are per-invocation only (never
 * config-file settable) — a persisted re-contract request would re-point every run in the tree.
 */
export function parseRecontract(flags: RawFlags): RecontractRequest | undefined {
  const max = str(flags, 'max-recontracts');
  if (flags['recontract'] === undefined) {
    if (max !== undefined) {
      throw new UsageError('--max-recontracts requires --recontract (with --from-run <runId>)');
    }
    return undefined;
  }
  if (max === undefined) return { maxRecontracts: DEFAULT_MAX_RECONTRACTS };
  const parsed = z.coerce.number().int().positive().safeParse(max);
  if (!parsed.success) {
    throw new UsageError(`--max-recontracts: expected a positive integer, got '${max}'`);
  }
  return { maxRecontracts: parsed.data };
}

/** Validate --log-level at the seam (fails closed on an unknown level). Default `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return 'info';
  const parsed = LogLevel.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`unknown log level: ${value} (expected debug | info | warn | error)`);
  }
  return parsed.data;
}

export function parseWorkspaceMode(value: string | undefined): 'git' | 'file' | 'auto' {
  if (value === undefined) return 'auto';
  if (value !== 'git' && value !== 'file' && value !== 'auto') {
    throw new UsageError(`--workspace-mode must be git|file|auto (got "${value}")`);
  }
  return value;
}
