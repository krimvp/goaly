/**
 * The Claude Code codec — all of `claude`'s per-CLI knowledge in one place (see {@link AgentCliCodec}).
 *
 * Assumed CLI contract:
 *   harness  (write):  claude -p "<prompt>" --output-format json [--model <m>] [--resume <id>]
 *   provider (read):   claude -p --output-format json [--model <m>]   (prompt on stdin)
 * Streaming swaps `--output-format json` → `stream-json --verbose` (per-turn JSONL). Either way the
 * closing `result` carries the SAME final text, recovered by the flat {@link parseAgentOutput} core.
 * Claude Code IS the reference Anthropic agent-SDK envelope, so its stream mapping simply IS the
 * shared {@link sdkStreamExtractor}.
 */

import { parseAgentOutput, flatExtractor } from './output';
import { sdkStreamExtractor } from './stream';
import { classifyFlatRun, type AgentCliCodec } from './codec';

const UNKNOWN_SESSION = 'claude-unknown';

/** Field strategy for Claude Code's flat `--output-format json` envelope (result/session_id/usage). */
const fieldExtractor = flatExtractor();

/** Claude Code's STREAM mapping for `--output-format stream-json` events (the SDK envelope). */
const streamExtractor = sdkStreamExtractor();

export const claudeCodec: AgentCliCodec = {
  name: 'claude-code',
  command: 'claude',
  unknownSession: UNKNOWN_SESSION,
  promptOnStdin: true,
  fieldExtractor,
  streamExtractor,
  harnessArgs({ prompt, model, sessionId, stream }) {
    const args = stream
      ? ['-p', prompt, '--output-format', 'stream-json', '--verbose']
      : ['-p', prompt, '--output-format', 'json'];
    if (model !== undefined) args.push('--model', model);
    if (sessionId !== undefined) args.push('--resume', sessionId);
    return args;
  },
  readonlyArgs({ model, stream }) {
    // The prompt is delivered on stdin (see `promptOnStdin`), so it is NOT an argv positional here.
    return [
      '-p',
      ...(stream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
      ...(model !== undefined ? ['--model', model] : []),
    ];
  },
  parse(stdout) {
    return parseAgentOutput(stdout, fieldExtractor);
  },
  classify(input) {
    return classifyFlatRun({
      parsed: parseAgentOutput(input.stdout, fieldExtractor),
      code: input.code,
      stderr: input.stderr,
      timedOut: input.timedOut,
      sessionId: input.sessionId,
      unknownSession: UNKNOWN_SESSION,
      estimator: input.estimator,
    });
  },
};
