/**
 * The Claude Code codec — all of `claude`'s per-CLI knowledge in one place (see {@link AgentCliCodec}).
 *
 * Assumed CLI contract:
 *   harness  (write):  claude -p "<prompt>" --output-format json --permission-mode acceptEdits [--model <m>] [--resume <id>]
 *   provider (read):   claude -p --output-format json [--model <m>] [--resume <id>]   (prompt on stdin)
 * Streaming swaps `--output-format json` → `stream-json --verbose` (per-turn JSONL). Either way the
 * closing `result` carries the SAME final text, recovered by the flat {@link parseAgentOutput} core.
 * Claude Code IS the reference Anthropic agent-SDK envelope, so its stream mapping simply IS the
 * shared {@link sdkStreamExtractor}.
 *
 * `--permission-mode acceptEdits` is MANDATORY for the harness role (the claude analogue of codex's
 * `--full-auto` / droid's `--auto`): headless `claude -p` defaults to PROMPTING for file edits, and a
 * prompt with no TTY is an auto-DENY — so without it the agent can diagnose a fix but never apply one,
 * and every iteration would no-diff and the run would abort. `acceptEdits` is the least-privilege mode
 * that still lets the agent edit the tree: it auto-accepts file edits but NOT `Bash`, so the agent
 * can't `git commit` (which would empty `git diff HEAD` and mislead the judge/approver). The read-only
 * LLM role must NOT get it (it judges, never edits) — it relies on the prompting default to stay
 * read-only, the same way droid's read-only role omits `--auto`.
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
  name: 'claude',
  command: 'claude',
  unknownSession: UNKNOWN_SESSION,
  promptOnStdin: true,
  fieldExtractor,
  streamExtractor,
  harnessArgs({ prompt, model, sessionId, stream }) {
    const args = stream
      ? ['-p', prompt, '--output-format', 'stream-json', '--verbose']
      : ['-p', prompt, '--output-format', 'json'];
    // Write role must be able to apply edits headlessly (see file header). Read role omits this.
    args.push('--permission-mode', 'acceptEdits');
    if (model !== undefined) args.push('--model', model);
    if (sessionId !== undefined) args.push('--resume', sessionId);
    return args;
  },
  readonlyArgs({ model, stream, sessionId }) {
    // The prompt is delivered on stdin (see `promptOnStdin`), so it is NOT an argv positional here.
    // `--resume` continues a prior read-only session (authoring continuity — see `readonlyResume`);
    // the role stays read-only either way (no `--permission-mode acceptEdits`).
    return [
      '-p',
      ...(stream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
      ...(model !== undefined ? ['--model', model] : []),
      ...(sessionId !== undefined ? ['--resume', sessionId] : []),
    ];
  },
  readonlyResume: true,
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
  interactiveResume(id) {
    return { command: `claude --resume ${id}` };
  },
};
