import type { AgentOutput } from '../agent-cli/output';
import { claudeCodec } from '../agent-cli/claude-codec';
import type { AgentExecFn } from '../agent-cli/codec';
import { AgentCliHarness } from './agent-cli-harness';

/**
 * Injectable subprocess seam. Returns the raw stdout/stderr, the process exit code, and a
 * `timedOut` flag. Tests pass a fake so they never spawn a real process. (Shared shape across every
 * codec-backed adapter — see {@link AgentExecFn}.)
 */
export type ExecFn = AgentExecFn;

/**
 * Claude Code's STREAM mapping for `--output-format stream-json` events — the shared Anthropic
 * agent-SDK envelope mapping the {@link claudeCodec} owns. Re-exported for embedders/tests.
 */
export const claudeStreamExtractor = claudeCodec.streamExtractor;

/**
 * Tolerantly parse Claude Code headless stdout (whole-object, object-amid-noise, or stream-json,
 * keeping the LAST result-bearing line). Returns `null` when no JSON object carries text. Never
 * throws. A thin wrapper over the {@link claudeCodec}'s field mapping.
 */
export function parseClaudeOutput(stdout: string): AgentOutput | null {
  return claudeCodec.parse(stdout);
}

/**
 * Headless Claude Code harness adapter — a thin binding of the {@link claudeCodec} over the generic
 * {@link AgentCliHarness}. Spawns `claude -p` and tolerantly parses its JSON output, never throwing
 * on hostile/partial output — failures become `crashed | truncated | timeout`.
 */
export class ClaudeCodeAdapter extends AgentCliHarness {
  constructor(opts: { exec?: ExecFn; timeoutMs?: number; model?: string } = {}) {
    super(claudeCodec, opts);
  }
}
