import type { AgentOutput } from '../agent-cli/output';
import {
  makeDroidCodec,
  droidCodec,
  DEFAULT_AUTONOMY,
  type AutonomyLevel,
} from '../agent-cli/droid-codec';
import type { AgentExecFn } from '../agent-cli/codec';
import { AgentCliHarness } from './agent-cli-harness';

export type { AutonomyLevel };

/**
 * Injectable subprocess seam. Returns raw stdout/stderr, the exit code, and a `timedOut` flag.
 * Tests pass a fake so they never spawn a real process. (Shared shape across every codec-backed
 * adapter — see {@link AgentExecFn}.)
 */
export type ExecFn = AgentExecFn;

/** The droid field/stream mappings the {@link droidCodec} owns, re-exported for embedders/tests. */
export const droidExtractor = droidCodec.fieldExtractor;
export const droidStreamExtractor = droidCodec.streamExtractor;

/**
 * Tolerantly parse droid headless stdout (whole-object, object-amid-noise, or a JSONL stream).
 * Returns `null` when no JSON object carries a `result`/`text`/`response` field. Never throws. A
 * thin wrapper over the {@link droidCodec}'s field mapping.
 */
export function parseDroidOutput(stdout: string): AgentOutput | null {
  return droidCodec.parse(stdout);
}

/**
 * Headless Factory `droid` harness adapter — a thin binding of a {@link makeDroidCodec} instance
 * (carrying the configured autonomy level) over the generic {@link AgentCliHarness}. Spawns
 * `droid exec` and tolerantly parses its JSON envelope, never throwing on hostile/partial output —
 * failures become `crashed | truncated | timeout` and the loop treats them as a failed iteration.
 */
export class DroidAdapter extends AgentCliHarness {
  constructor(
    opts: {
      exec?: ExecFn;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      auto?: AutonomyLevel;
      model?: string;
      cwd?: string;
    } = {},
  ) {
    super(makeDroidCodec(opts.auto ?? DEFAULT_AUTONOMY), opts);
  }
}
