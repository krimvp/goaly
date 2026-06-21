import type { AgentOutput } from '../agent-cli/output';
import { codexCodec } from '../agent-cli/codex-codec';
import type { AgentExecFn, AgentExecResult } from '../agent-cli/codec';
import { AgentCliHarness } from './agent-cli-harness';

/**
 * Raw result of spawning the codex binary. `code` is the process exit code (null when the process
 * was killed before exiting), `timedOut` is set when we killed it for exceeding the wall-clock
 * budget. This is the SEAM: tests inject a fake `ExecFn`, production spawns codex. (Shared shape
 * across every codec-backed adapter — see {@link AgentExecResult}.)
 */
export type ExecResult = AgentExecResult;

export type ExecFn = AgentExecFn;

/** The codex field/stream mappings the {@link codexCodec} owns, re-exported for embedders/tests. */
export const codexExtractor = codexCodec.fieldExtractor;
export const codexStreamExtractor = codexCodec.streamExtractor;

/**
 * Tolerantly walk codex `--json` JSONL stdout. Returns the final assistant/result text, plus a
 * session/thread id and token usage when present, or `null` when no line is valid JSON or no usable
 * text was found. Never throws. A thin wrapper over the {@link codexCodec}'s field mapping.
 */
export function parseCodexOutput(stdout: string): AgentOutput | null {
  return codexCodec.parse(stdout);
}

/**
 * Codex headless adapter — a thin binding of the {@link codexCodec} over the generic
 * {@link AgentCliHarness}. Never throws, classifies output into
 * `completed | crashed | truncated | timeout`, and always returns a Zod-parsed HarnessRunResult.
 * The subprocess is injectable so tests never spawn a real process.
 */
export class CodexAdapter extends AgentCliHarness {
  constructor(opts: { exec?: ExecFn; timeoutMs?: number; model?: string } = {}) {
    super(codexCodec, opts);
  }
}
