import type { AgentOutput } from '../agent-cli/output';
import { piCodec } from '../agent-cli/pi-codec';
import type { AgentExecFn } from '../agent-cli/codec';
import { AgentCliHarness } from './agent-cli-harness';

/**
 * Injectable subprocess seam. Returns raw stdout/stderr, the exit code, and a `timedOut` flag.
 * Tests pass a fake so they never spawn a real process. (Shared shape across every codec-backed
 * adapter — see {@link AgentExecFn}.)
 */
export type ExecFn = AgentExecFn;

/** The pi field/stream mappings the {@link piCodec} owns, re-exported for embedders/tests. */
export const piExtractor = piCodec.fieldExtractor;
export const piStreamExtractor = piCodec.streamExtractor;

/**
 * Tolerantly parse pi (`--mode json`) headless stdout (a JSONL event stream — keep the LAST assistant
 * message's text, latch the `session` event's id). Returns `null` when no JSON object carries text.
 * Never throws. A thin wrapper over the {@link piCodec}'s field mapping.
 */
export function parsePiOutput(stdout: string): AgentOutput | null {
  return piCodec.parse(stdout);
}

/**
 * Headless pi (pi.dev) harness adapter — a thin binding of the {@link piCodec} over the generic
 * {@link AgentCliHarness}. Spawns `pi --print --mode json` and tolerantly parses its JSONL envelope,
 * never throwing on hostile/partial output — failures become `crashed | truncated | timeout` and the
 * loop treats them as a failed iteration.
 */
export class PiAdapter extends AgentCliHarness {
  constructor(
    opts: {
      exec?: ExecFn;
      timeoutMs?: number;
      idleTimeoutMs?: number;
      model?: string;
      cwd?: string;
    } = {},
  ) {
    super(piCodec, opts);
  }
}
