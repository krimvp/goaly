/**
 * The Factory `droid` codec — all of `droid`'s per-CLI knowledge in one place
 * (see {@link AgentCliCodec}). https://docs.factory.ai/cli
 *
 * Assumed CLI contract (verified against droid 0.153.1 — the EXACT flags may drift between versions;
 * this is the seam, not a hard dependency):
 *   harness  (write):  droid exec --output-format json --auto <level> [--model <m>] [--session-id <id>] "<prompt>"
 *   provider (read):   droid exec --output-format json [--model <m>] "<prompt>"   (no --auto)
 *
 * droid emits the Anthropic agent-SDK envelope, so its final-result parse reuses the flat
 * {@link flatExtractor} (with droid's `is_error` soft-error key) and its stream mapping reuses the
 * shared {@link sdkStreamExtractor} — droid and claude share one stream mapping. Streaming
 * swaps `--output-format json` → `stream-json` for the per-turn JSONL.
 *
 * Autonomy: `droid exec` defaults to READ-ONLY (cannot modify files) — useless for a goaly loop — so
 * the harness role always passes `--auto`. The default is `low` (file create/modify only, no
 * git/installs/builds): the least privilege that still lets the agent edit the working tree while
 * keeping the orchestrator's HEAD-relative `diff()` honest (`low` cannot `git commit`, which would
 * empty `git diff HEAD` and mislead the judge/approver). Embedders can opt into `medium`/`high`. The
 * read-only LLM role exploits the read-only default: it omits `--auto` so a judge/approver can never
 * mutate the tree it is judging. We never pass `--skip-permissions-unsafe`.
 */

import { parseAgentOutput, flatExtractor } from './output';
import { sdkStreamExtractor } from './stream';
import { classifyFlatRun, type AgentCliCodec } from './codec';

/** Autonomy tiers `droid exec` accepts via `--auto`. */
export type AutonomyLevel = 'low' | 'medium' | 'high';

/** Least-privilege default: edit files, but no git/installs/builds (keeps `diff HEAD` honest). */
export const DEFAULT_AUTONOMY: AutonomyLevel = 'low';

const UNKNOWN_SESSION = 'droid-unknown';

/** Field strategy for droid's flat result envelope (result/session_id/usage/is_error). */
const fieldExtractor = flatExtractor({ errorKey: 'is_error' });

/** droid's STREAM mapping (the shared Anthropic agent-SDK mapping, with droid's `is_error` key). */
const streamExtractor = sdkStreamExtractor({ errorKey: 'is_error' });

/**
 * Build a droid codec for a given autonomy level (the only per-instance knob). The extractors,
 * read-only argv, and classifier are autonomy-independent, so the read-only LLM role can use any
 * instance (e.g. the default {@link droidCodec}).
 */
export function makeDroidCodec(auto: AutonomyLevel = DEFAULT_AUTONOMY): AgentCliCodec {
  return {
    name: 'droid',
    command: 'droid',
    unknownSession: UNKNOWN_SESSION,
    promptOnStdin: false,
    fieldExtractor,
    streamExtractor,
    harnessArgs({ prompt, model, sessionId, stream }) {
      // Flags first, prompt last (so a prompt is never mistaken for a flag value). A sessionId is a
      // branded, allowlisted string (it can never begin with `-`), so `--session-id <id>` is safe.
      const args = ['exec', '--output-format', stream ? 'stream-json' : 'json', '--auto', auto];
      if (model !== undefined) args.push('--model', model);
      if (sessionId !== undefined) args.push('--session-id', sessionId);
      args.push(prompt);
      return args;
    },
    readonlyArgs({ prompt, model }) {
      return ['exec', '--output-format', 'json', ...(model !== undefined ? ['--model', model] : []), prompt];
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
    interactiveResume(id) {
      return { command: `droid --session-id ${id}` };
    },
  };
}

/** The default-autonomy (`low`) droid codec — used by the read-only LLM role and as the base. */
export const droidCodec = makeDroidCodec();

/** Streaming sibling of `droidExtractor`, re-exported for embedders/tests. */
export const droidStreamExtractor = streamExtractor;

/** Field strategy for droid's flat result envelope, re-exported for embedders/tests. */
export const droidExtractor = fieldExtractor;
