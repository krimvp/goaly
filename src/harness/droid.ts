import { coerceSessionId, type SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import { runProcess } from '../util/spawn';
import type { HarnessAdapter } from './adapter';
import { parseAgentOutput, flatExtractor, type AgentOutput } from '../agent-cli/output';
import { classifyHarnessRun } from './classify';

/**
 * Seam #1 implementation for Factory's `droid` CLI (https://docs.factory.ai/cli).
 *
 * Assumed CLI contract (verified against droid 0.153.1 — the EXACT flags may drift between
 * versions; this is the seam, not a hard dependency):
 *
 *   Fresh turn:   droid exec --output-format json --auto <level> "<prompt>"
 *   Resume turn:  droid exec --output-format json --auto <level> --session-id <id> "<prompt>"
 *
 * Output shape (the Anthropic agent-SDK envelope) is parsed tolerantly by the shared
 * {@link parseAgentOutput} core via {@link droidExtractor}.
 *
 * Autonomy: `droid exec` defaults to READ-ONLY, where the agent cannot modify files — useless for
 * a goaly loop. So we always pass `--auto`. The default is `low` (file create/modify only, no
 * git/installs/builds): it is the least privilege that still lets the agent do its essential job —
 * editing the working tree — while keeping the orchestrator's HEAD-relative `diff()` honest, since
 * `low` cannot `git commit` (a commit would empty `git diff HEAD` and mislead the judge/approver).
 * goaly runs verification itself, so the agent needs no build/test privileges. Embedders who
 * want the agent to install deps / build / run tests can opt into `medium`/`high` via the
 * constructor (accepting the commit caveat). We never pass `--skip-permissions-unsafe`.
 *
 * (The read-only default is exploited elsewhere: the droid LLM provider omits `--auto` entirely so
 * a judge/approver can never mutate the tree it is judging.)
 */

/**
 * Injectable subprocess seam. Returns raw stdout/stderr, the exit code, and a `timedOut` flag.
 * Tests pass a fake so they never spawn a real process.
 */
export type ExecFn = (
  args: string[],
  input: { prompt: string },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

/** Autonomy tiers `droid exec` accepts via `--auto`. */
export type AutonomyLevel = 'low' | 'medium' | 'high';

/** Sentinel session id used whenever we have no usable session from the CLI or the caller. */
const UNKNOWN_SESSION = 'droid-unknown';

/** Default wall-clock budget for a single headless invocation. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Least-privilege default: edit files, but no git/installs/builds (keeps `diff HEAD` honest). */
const DEFAULT_AUTONOMY: AutonomyLevel = 'low';

/** Field strategy for droid's flat result envelope (result/session_id/usage/is_error). */
export const droidExtractor = flatExtractor({ errorKey: 'is_error' });

/**
 * Tolerantly parse droid headless stdout (whole-object, object-amid-noise, or a JSONL stream).
 * Returns `null` when no JSON object carries a `result`/`text`/`response` field. Never throws. A
 * thin wrapper over the shared {@link parseAgentOutput} core.
 */
export function parseDroidOutput(stdout: string): AgentOutput | null {
  return parseAgentOutput(stdout, droidExtractor);
}

/**
 * Build the argv for one headless turn. Flags first, prompt last (so a prompt is never mistaken
 * for a flag value). A `sessionId` is a branded, allowlisted string (it can never begin with `-`),
 * so threading it into `--session-id` is safe.
 */
function buildArgs(
  prompt: string,
  auto: AutonomyLevel,
  model: string | undefined,
  sessionId?: SessionId,
): string[] {
  const args = ['exec', '--output-format', 'json', '--auto', auto];
  if (model !== undefined) args.push('--model', model);
  if (sessionId !== undefined) args.push('--session-id', sessionId);
  args.push(prompt);
  return args;
}

/**
 * Real subprocess implementation: spawn the `droid` binary via the shared {@link runProcess}
 * helper (which caps output, enforces the timeout, and never rejects). The prompt is delivered as
 * an argv value — droid only reads stdin under `--input-format stream-json`, which we do not use —
 * so we do not write it to stdin.
 */
function defaultExec(timeoutMs: number): ExecFn {
  return async (args, _input) => {
    const r = await runProcess('droid', args, { timeoutMs });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  };
}

/**
 * Headless Factory `droid` harness adapter. Spawns `droid exec` and tolerantly parses its JSON
 * envelope, never throwing on hostile/partial output — failures become
 * `crashed | truncated | timeout` and the loop treats them as a failed iteration.
 */
export class DroidAdapter implements HarnessAdapter {
  readonly name = 'droid';
  readonly #exec: ExecFn;
  readonly #auto: AutonomyLevel;
  readonly #model: string | undefined;

  constructor(
    opts: { exec?: ExecFn; timeoutMs?: number; auto?: AutonomyLevel; model?: string } = {},
  ) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#exec = opts.exec ?? defaultExec(timeoutMs);
    this.#auto = opts.auto ?? DEFAULT_AUTONOMY;
    this.#model = opts.model;
  }

  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = buildArgs(prompt, this.#auto, this.#model, sessionId);

    let result: { stdout: string; stderr: string; code: number; timedOut?: boolean };
    try {
      result = await this.#exec(args, { prompt });
    } catch (err) {
      // The exec seam should never reject, but fail-closed if it does.
      return HarnessRunResult.parse({
        output: err instanceof Error ? err.message : String(err),
        sessionId: coerceSessionId(sessionId, UNKNOWN_SESSION),
        status: 'crashed',
      });
    }

    return classifyHarnessRun({
      parsed: parseDroidOutput(result.stdout),
      code: result.code,
      stderr: result.stderr,
      timedOut: result.timedOut,
      sessionId,
      unknownSession: UNKNOWN_SESSION,
    });
  }
}
