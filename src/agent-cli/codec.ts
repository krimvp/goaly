/**
 * One deep module per coding-agent CLI. The knowledge of how to speak to a single CLI — its two
 * argv dialects (write-mode harness + read-only LLM), its field extractor, its stream extractor,
 * and its run-status mapping — used to be smeared across five modules (`agent-cli/output.ts`,
 * `harness/<tool>.ts`, `harness/classify.ts`, `cli/compose.ts`, `llm/cli-provider.ts`). An
 * {@link AgentCliCodec} consolidates ALL of it behind one small interface, so adding a CLI is one
 * codec module and the per-CLI quirks live in exactly one place (locality).
 *
 * Two consumers justify the seam, and BOTH go through the codec — never through harness internals:
 *   - the write-role {@link HarnessAdapter} (seam #1) drives the agent (`harnessArgs` + `classify`);
 *   - the read-only `AgentCliLlmProvider` (the judge/approver/compiler LLM role) uses `readonlyArgs`
 *     + the same `fieldExtractor`/`streamExtractor`.
 * That kills the old `llm → harness` and `compose → harness-internals` import leaks: both the LLM
 * provider and the composition root import the codec from this neutral `agent-cli/` layer.
 */

import { SessionId, coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import { runProcess } from '../util/spawn';
import { parseAgentOutput, type AgentOutput, type FieldExtractor } from './output';
import { StreamTap, type AgentEventSink, type StreamEventExtractor } from './stream';
import { accountTokens, streamingEstimator, type StreamTokenEstimator } from './estimate';

/** Default wall-clock budget for a single headless invocation (harness or read-only LLM turn). */
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Raw result of spawning an agent CLI. `code` is the process exit code (`null` when the process was
 * killed before exiting — normalised to a non-zero exit downstream); `timedOut` is set when we
 * killed it for exceeding the wall-clock budget. This is the SEAM: tests inject a fake `exec`,
 * production spawns the real binary via {@link defaultAgentExec}.
 */
export type AgentExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
};

/**
 * Injectable subprocess seam shared by every codec-backed adapter. Takes the full argv plus the
 * prompt (some CLIs read it from stdin), and an optional live stdout tap (issue #23). Tests pass a
 * fake so they never spawn a real process; production uses {@link defaultAgentExec}.
 */
export type AgentExecFn = (
  args: string[],
  input: { prompt: string },
  onStdout?: (chunk: string) => void,
) => Promise<AgentExecResult>;

/** The arguments a codec maps a run into before classifying it. The codec parses `stdout` itself. */
export type CodecClassifyInput = {
  stdout: string;
  stderr: string;
  /** Normalised exit code: `null` (signal-killed) is treated as a non-zero/failed exit. */
  code: number | null;
  timedOut?: boolean | undefined;
  /** The resume session id passed into `run()`, used as a fallback when stdout carries none. */
  sessionId?: SessionId | undefined;
  /** Streaming token estimator (issue #24); present only when the run streamed. */
  estimator?: StreamTokenEstimator | undefined;
};

/**
 * Everything goaly needs to know to speak to ONE coding-agent CLI, in one place. The harness role
 * and the read-only LLM role both consume it; nothing tool-specific leaks past it.
 */
export interface AgentCliCodec {
  /** Short identifier for logs (e.g. "claude", "codex", "droid"). */
  readonly name: string;
  /** The binary to spawn (e.g. "claude", "codex", "droid"). */
  readonly command: string;
  /** Safe sentinel session id when none is recovered from stdout or the caller. */
  readonly unknownSession: string;
  /** Whether the prompt is also written to the child's stdin (claude) vs argv-only (codex/droid). */
  readonly promptOnStdin: boolean;
  /** Field strategy for this CLI's final-result envelope (the streaming-agnostic parse). */
  readonly fieldExtractor: FieldExtractor;
  /** Streaming sibling of `fieldExtractor`: maps per-turn JSONL onto the canonical event taxonomy. */
  readonly streamExtractor: StreamEventExtractor;

  /**
   * Write-mode argv (the HARNESS role: the agent may edit the working tree). `stream` requests
   * per-turn JSONL where the CLI distinguishes it from its normal structured output.
   */
  harnessArgs(opts: {
    prompt: string;
    model: string | undefined;
    sessionId?: SessionId | undefined;
    stream: boolean;
  }): string[];

  /**
   * Read-only argv (the LLM role: judge / approver / compiler — must NEVER edit the tree). `stream`
   * requests per-turn JSONL where applicable; a CLI whose structured output is already a JSONL
   * stream ignores it. `sessionId` resumes a prior READ-ONLY session (authoring continuity for the
   * compiler/planner revise loops) — only passed when {@link readonlyResume} is true; a codec
   * without that capability never receives it.
   */
  readonlyArgs(opts: {
    prompt: string;
    model: string | undefined;
    stream: boolean;
    sessionId?: string | undefined;
    /** A goaly-MINTED fresh session id to create (claude: `--session-id <uuid>`); see {@link readonlyMintSession}. */
    newSessionId?: string | undefined;
  }): string[];

  /**
   * Whether this CLI can RESUME a session in its read-only/headless dialect (claude:
   * `-p --resume <id>`). Gates {@link LlmProvider.supportsResume} on the agent-CLI provider so the
   * authoring roles only attempt a resume where the CLI genuinely supports it — absent/false means
   * every read-only call is a fresh session (the historical behavior, and always a safe fallback).
   */
  readonly readonlyResume?: boolean;

  /**
   * Whether this CLI accepts an EXPLICIT fresh session id in its read-only dialect (claude:
   * `-p --session-id <uuid>`). Lets the provider mint a goaly-owned session per authoring call, so
   * a later resume replays ONLY that caller's turns — immune to environments that pin every bare
   * call to one ambient shared session. Absent/false ⇒ `mintSession` requests are ignored.
   */
  readonly readonlyMintSession?: boolean;

  /** Tolerantly parse this CLI's stdout into the shared {@link AgentOutput}. Never throws. */
  parse(stdout: string): AgentOutput | null;

  /**
   * Map a raw run into a Zod-parsed {@link HarnessRunResult}. Owns the per-tool status policy
   * (claude/droid share {@link classifyFlatRun}; codex keeps its inverted mapping). Never throws.
   */
  classify(input: CodecClassifyInput): HarnessRunResult;

  /**
   * The command to CONTINUE this CLI's own INTERACTIVE session after a goaly run ends (Capability A,
   * `goaly runs resume-cmd`). Each CLI's interactive-resume phrasing differs from the headless
   * `harnessArgs` goaly drives, so it lives per-codec (locality). Returns the command string and an
   * optional honest `caveat` (e.g. codex's interactive form differs from `exec`; pi resumes the
   * latest cwd session only). Pure string-building — no IO. Optional: a codec without an interactive
   * resume simply omits it (the resume-hint then degrades to a typed "none").
   */
  interactiveResume?(id: SessionId): { command: string; caveat?: string };
}

/**
 * Default production exec: spawn the real binary via the shared {@link runProcess} (one tested
 * subprocess dance — output cap, timeout, never-reject — for the whole codebase). The prompt is
 * delivered on argv by the codec's `*Args`; for CLIs that also read it from stdin (`promptOnStdin`)
 * we additionally write it there.
 */
export function defaultAgentExec(
  command: string,
  timeoutMs: number,
  promptOnStdin: boolean,
  cwd?: string,
  idleTimeoutMs?: number,
): AgentExecFn {
  return async (args, input, onStdout) => {
    const r = await runProcess(command, args, {
      timeoutMs,
      // Agent CLIs spawn their own tools/tests, which inherit the stdio pipes. Killing only the
      // CLI on a timeout would orphan those children and (because the pipes stay open) hang the
      // run forever past its own cap — group-kill the whole tree instead (see runProcess).
      killGroup: true,
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      // Run the agent IN the workspace, not goaly's own cwd. Otherwise the agent edits whatever
      // directory goaly was invoked from, and a `--workspace` that differs from that cwd (e.g. under
      // `npm run`, which resets cwd to the package root) makes every edit land outside the tree goaly
      // diffs/verifies — the run then no-diff-aborts despite a real build. When sandboxed, the
      // launcher sets the jail's cwd instead and this default exec is not used.
      ...(cwd !== undefined ? { cwd } : {}),
      ...(promptOnStdin ? { input: input.prompt } : {}),
      ...(onStdout !== undefined ? { onStdout } : {}),
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  };
}

/**
 * The AMBIENT session id when goaly itself runs nested under Claude Code (e.g. inside a Claude Code
 * remote environment). A spawned `claude -p` there adopts and REPORTS this id instead of minting a
 * fresh per-call session, and every call in a cwd appends to that ONE shared session file — so
 * resuming it would replay the OUTER conversation's turns (and every sibling goaly LLM step) into
 * the worker's context, not the worker's own working memory. Observed empirically; scrubbing the
 * variable from the child env does NOT stop the pinning (the wrapped CLI keeps it), so the only
 * safe policy is to never TRUST the ambient id: treat it exactly like the codec's unknown-session
 * sentinel — never surface it as a resumable session and never thread it into `--resume`. Shared by
 * the harness core (below) and the read-only {@link ../llm/agent-cli-provider!AgentCliLlmProvider}.
 */
export function ambientSessionId(): string | undefined {
  const v = process.env['CLAUDE_CODE_SESSION_ID'];
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * The one harness `run()` body, parameterised by a codec. Builds the optional stream tap (and the
 * issue-#24 token estimator), asks the codec for the write-mode argv, runs the injected `exec`
 * (never rejecting — a thrown exec becomes a fail-closed `crashed`), flushes the tap, and lets the
 * codec classify. Shared by every codec-backed {@link HarnessAdapter} so the spawn/parse/classify
 * dance lives in exactly one place.
 */
export async function runCodecHarness(
  codec: AgentCliCodec,
  exec: AgentExecFn,
  model: string | undefined,
  prompt: string,
  sessionId?: SessionId,
  onEvent?: AgentEventSink,
  /**
   * Force the CLI into its per-turn STREAMING output mode even when no `onEvent` tap is attached
   * (issue: idle-timeout footgun). The idle/heartbeat timeout re-arms on child stdout chunks, but a
   * CLI in its buffered `--output-format json` mode emits nothing until the turn ends — so a long,
   * progressing turn gets reaped at the idle deadline. When an idle timeout is configured, the harness
   * sets this so the CLI streams per-turn JSONL (heartbeat keeps re-arming). Parsing is unaffected:
   * `classify` always parses the full `stdout`, which tolerates the stream-json envelope with or
   * without a tap (a bonus: the streamed `result` event also carries usage the buffered mode omits).
   */
  forceStream?: boolean,
): Promise<HarnessRunResult> {
  const { sink, estimator } = streamingEstimator(onEvent);
  const tap = sink !== undefined ? new StreamTap(codec.streamExtractor, sink) : undefined;
  // A prior turn that never yielded a recoverable session id carries the codec's `unknownSession`
  // sentinel (e.g. a timed-out first turn returns no session_id). NEVER thread that into a resume:
  // `<cli> --resume claude-unknown` is rejected by the CLI ("not a UUID") and would crash EVERY
  // continuation turn, turning one slow/timed-out turn into a dead run — a false STUCK_HARNESS_CRASH.
  // Drop it so the next turn starts a FRESH session instead; the worker loses that turn's chat memory
  // but keeps making real progress against the frozen contract (which alone governs DONE).
  // The AMBIENT id (goaly nested under Claude Code) is refused the same way: resuming it would pull
  // the OUTER conversation — and every sibling LLM step sharing that session file — into the worker
  // (see {@link ambientSessionId}).
  const resumeId =
    sessionId === codec.unknownSession || sessionId === ambientSessionId() ? undefined : sessionId;
  const args = codec.harnessArgs({
    prompt,
    model,
    ...(resumeId !== undefined ? { sessionId: resumeId } : {}),
    stream: tap !== undefined || forceStream === true,
  });

  let result: AgentExecResult;
  try {
    result = await exec(args, { prompt }, tap ? (chunk) => tap.push(chunk) : undefined);
  } catch (err) {
    // The exec seam should never reject, but fail-closed if it does.
    tap?.end();
    return HarnessRunResult.parse({
      output: err instanceof Error ? err.message : String(err),
      sessionId: coerceSessionId(resumeId, codec.unknownSession),
      status: 'crashed',
    });
  }
  tap?.end(); // flush a final unterminated JSONL line before classification

  const classified = codec.classify({
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
    ...(resumeId !== undefined ? { sessionId: resumeId } : {}),
    ...(estimator !== undefined ? { estimator } : {}),
  });
  // Never SURFACE the ambient id either: a nested CLI reports it as its session_id, and anything
  // downstream that stores it (the run log, the resume hint, --inherit-session) would later resume
  // the outer conversation. Coerce it to the codec's unknown-session sentinel — "no resumable
  // session" — which every consumer already skips.
  if (classified.sessionId === ambientSessionId()) {
    return { ...classified, sessionId: coerceSessionId(undefined, codec.unknownSession) };
  }
  return classified;
}

/**
 * The shared run-status classifier for the FLAT codecs (claude, droid), whose `run()` tails are
 * identical: a timeout salvages any parsed text → `timeout`; a non-zero/killed exit → `crashed`;
 * exit-0 with no usable text → `truncated`; a soft `isError` flag (droid) → `truncated`; otherwise
 * `completed` (+tokens). Codex maps the non-zero / no-text cases the other way (no-parse → crashed,
 * non-zero-with-text → truncated), so its codec keeps its own `classify`. Never throws — always a
 * Zod-parsed {@link HarnessRunResult}. The exec-rejects-itself case is handled in
 * {@link runCodecHarness}.
 */
export function classifyFlatRun(opts: {
  parsed: AgentOutput | null;
  code: number | null;
  stderr: string;
  timedOut?: boolean | undefined;
  sessionId?: string | undefined;
  unknownSession: string;
  estimator?: StreamTokenEstimator | undefined;
}): HarnessRunResult {
  const { parsed, code, stderr, timedOut, sessionId, unknownSession, estimator } = opts;
  const session = coerceSessionId(parsed?.sessionId ?? sessionId, unknownSession);

  if (timedOut === true) {
    return HarnessRunResult.parse({
      output: parsed?.text ?? stderr,
      sessionId: session,
      status: 'timeout',
    });
  }
  if (code !== 0) {
    return HarnessRunResult.parse({
      output: stderr.length > 0 ? stderr : (parsed?.text ?? ''),
      sessionId: session,
      status: 'crashed',
    });
  }
  if (parsed === null || parsed.text.length === 0) {
    return HarnessRunResult.parse({
      output: stderr,
      sessionId: session,
      status: 'truncated',
    });
  }
  const status: HarnessRunResult['status'] = parsed.isError === true ? 'truncated' : 'completed';
  const acct = accountTokens(parsed.tokens, estimator);
  return HarnessRunResult.parse({
    output: parsed.text,
    sessionId: session,
    status,
    ...acct,
    // The split belongs only to a provider-REPORTED count; a local estimate has no category split.
    ...(acct.tokenSource === 'reported' && parsed.breakdown !== undefined
      ? { tokenBreakdown: parsed.breakdown }
      : {}),
  });
}
