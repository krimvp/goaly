import { randomUUID } from 'node:crypto';
import type { LlmCompletion, LlmProvider, LlmRequest } from './provider';
import { runProcess } from '../util/spawn';
import { parseAgentOutput } from '../agent-cli/output';
import { StreamTap, type AgentEventSink } from '../agent-cli/stream';
import { accountTokens, streamingEstimator } from '../agent-cli/estimate';
import type { AgentCliCodec } from '../agent-cli/codec';

/**
 * Injectable subprocess seam: takes the full argv plus the prompt (delivered on stdin only when the
 * codec says so), and an optional live stdout tap. Tests pass a fake so they never spawn a process.
 */
type ExecFn = (
  args: string[],
  input: string | undefined,
  onStdout?: (chunk: string) => void,
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

/** Default wall-clock budget for one completion. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** Default retries (total attempts = retries + 1) on a transient CLI failure. */
const DEFAULT_RETRIES = 2;
/** Linear backoff base between attempts. */
const BACKOFF_MS = 1000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The AMBIENT session id when goaly itself runs nested under Claude Code (e.g. inside a Claude Code
 * remote environment). A spawned `claude -p` there adopts and REPORTS this id instead of minting a
 * fresh per-call session, and every call in a cwd appends to that ONE shared session file — so
 * resuming it would replay sibling steps' turns (the shape classifier, the red-team critics, …)
 * into the authoring context, not the author's own conversation. Observed empirically; scrubbing
 * the variable from the child env does NOT stop the pinning (the wrapped CLI keeps it), so the
 * only safe policy is to never TRUST the ambient id: drop it from completions and refuse it as a
 * resume target — authoring then degrades to fresh full-prompt calls, the pre-feature behavior.
 */
function ambientSessionId(): string | undefined {
  const v = process.env['CLAUDE_CODE_SESSION_ID'];
  return v !== undefined && v.length > 0 ? v : undefined;
}

/**
 * The ONE {@link LlmProvider} backed by a coding-agent CLI, driven entirely by that CLI's
 * {@link AgentCliCodec}. The judge / approver / compiler use a CLI's model in a READ-ONLY dialect
 * (`codec.readonlyArgs`), so they can reason over the working tree without ever mutating it. Every
 * per-CLI quirk — the read-only argv, whether the prompt rides on stdin (`promptOnStdin`), the
 * final-result field mapping (`fieldExtractor`), and the per-turn stream mapping (`streamExtractor`)
 * — comes from the codec, so this provider is the same code for claude, codex, droid, pi, and any
 * future CLI. It reuses the same tolerant {@link parseAgentOutput} core as the harness role and
 * FAILS CLOSED (throws) when no parseable text comes back (invariant #4) — a thrown LLM step becomes
 * a fail-closed verdict / veto upstream, never a fabricated green.
 *
 * Transient resilience: a non-zero exit or empty/unparseable output (the shapes a momentary
 * rate-limit / network / auth blip produces) is retried with bounded linear backoff — the same
 * policy the OpenAI transport already had — so one CLI hiccup doesn't become a wasted iteration
 * (fail-closed veto / unevaluable red) or a dead run. A TIMEOUT is NOT retried: the wall-clock cap
 * is the run's own guard, and doubling it silently would defeat it. After the last attempt the
 * error still throws — fail-closed, never a fabricated completion.
 */
export class AgentCliLlmProvider implements LlmProvider {
  readonly name: string;
  /** Capability-gated by the codec: only a CLI with a read-only resume dialect can honor one. */
  readonly supportsResume: boolean;
  readonly #codec: AgentCliCodec;
  readonly #model: string | undefined;
  readonly #exec: ExecFn;
  readonly #retries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Streaming tap (issue #23), wired at CONSTRUCTION so the Verifier/Approver seams stay clean. */
  readonly #onEvent: AgentEventSink | undefined;

  constructor(opts: {
    codec: AgentCliCodec;
    model?: string;
    exec?: ExecFn;
    timeoutMs?: number;
    /** Retries on a transient failure (non-zero exit / unparseable output). Default {@link DEFAULT_RETRIES}. */
    retries?: number;
    /** Injected backoff sleep (tests pass a no-op). Default a real timer. */
    sleep?: (ms: number) => Promise<void>;
    /**
     * Opt-in streaming sink. When set, this provider forwards the read-only agent turn's intermediate
     * events as they arrive, mapped through the codec's `streamExtractor`. The LLM steps share the
     * harness parser, so this is the same {@link StreamTap} machinery — only the sink injection point
     * differs (construction, not a `complete()` arg), keeping `LlmProvider` an internal seam.
     */
    onEvent?: AgentEventSink;
  }) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#codec = opts.codec;
    this.#model = opts.model;
    this.name = `cli:${opts.codec.name}`;
    this.supportsResume = opts.codec.readonlyResume === true;
    this.#retries = opts.retries ?? DEFAULT_RETRIES;
    this.#sleep = opts.sleep ?? realSleep;
    this.#onEvent = opts.onEvent;
    this.#exec =
      opts.exec ??
      ((args, input, onStdout) =>
        runProcess(opts.codec.command, args, {
          ...(input !== undefined ? { input } : {}),
          timeoutMs,
          // Same group-kill rationale as the harness exec: a timed-out CLI turn must never leave
          // descendants holding the stdio pipes open (the run would hang past its own timeout).
          killGroup: true,
          ...(onStdout !== undefined ? { onStdout } : {}),
        }));
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    let lastError: Error = new Error(`LLM CLI ${this.name} failed`);
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      if (attempt > 0) await this.#sleep(BACKOFF_MS * attempt);
      const outcome = await this.#attempt(req);
      if (outcome.ok) return outcome.value;
      lastError = outcome.error;
      if (!outcome.retriable) break;
    }
    throw lastError;
  }

  /** One CLI invocation. Retry policy lives in {@link complete}; a timeout is never retried. */
  async #attempt(
    req: LlmRequest,
  ): Promise<
    | { ok: true; value: LlmCompletion }
    | { ok: false; retriable: boolean; error: Error }
  > {
    const prompt = req.system !== undefined ? `${req.system}\n\n${req.prompt}` : req.prompt;
    // When streaming, accumulate a local token estimate (issue #24) from the turns, used as a
    // fallback when the agent CLI reports no usage.
    const { sink, estimator } = streamingEstimator(this.#onEvent);
    const tap = sink !== undefined ? new StreamTap(this.#codec.streamExtractor, sink) : undefined;
    // A resume is honored only where the codec's read-only dialect supports it, and never with the
    // codec's unknown-session sentinel (same guard as the harness: `--resume claude-unknown` would
    // crash the call rather than degrade to a fresh session) or the AMBIENT session id (below).
    const resume =
      this.supportsResume &&
      req.resumeSessionId !== undefined &&
      req.resumeSessionId !== this.#codec.unknownSession &&
      req.resumeSessionId !== ambientSessionId()
        ? req.resumeSessionId
        : undefined;
    // Mint a goaly-owned session where the codec supports an explicit id — PER ATTEMPT, never
    // reused: the CLI rejects a second `--session-id` with the same value ("already in use"), so a
    // retry after a transient failure must mint fresh rather than collide with the half-created
    // session (the orphaned file is harmless). Mutually exclusive with a resume.
    const minted =
      resume === undefined && req.mintSession === true && this.#codec.readonlyMintSession === true
        ? randomUUID()
        : undefined;
    const args = this.#codec.readonlyArgs({
      prompt,
      model: this.#model,
      stream: tap !== undefined,
      ...(resume !== undefined ? { sessionId: resume } : {}),
      ...(minted !== undefined ? { newSessionId: minted } : {}),
    });
    // The prompt rides on stdin only for CLIs that read it there (claude); the others carry it on argv.
    const input = this.#codec.promptOnStdin ? prompt : undefined;
    const r = await this.#exec(args, input, tap ? (chunk) => tap.push(chunk) : undefined);
    tap?.end();
    if (r.timedOut === true) {
      // Not retriable: the wall-clock cap is the run's own guard; retrying would silently double it.
      return { ok: false, retriable: false, error: new Error(`LLM CLI ${this.name} timed out`) };
    }
    if (r.code !== 0) {
      return {
        ok: false,
        retriable: true,
        error: new Error(`LLM CLI ${this.name} exited ${r.code}: ${r.stderr.slice(0, 500)}`),
      };
    }
    const parsed = parseAgentOutput(r.stdout, this.#codec.fieldExtractor);
    if (parsed === null || parsed.text.length === 0) {
      // Fail-closed (invariant #4): empty/unparseable output is never passed through as a verdict.
      return {
        ok: false,
        retriable: true,
        error: new Error(
          `LLM CLI ${this.name} produced no parseable text (exit ${r.code}, ${r.stdout.length}B stdout)`,
        ),
      };
    }
    const acct = accountTokens(parsed.tokens, estimator);
    return {
      ok: true,
      value: {
        text: parsed.text,
        ...acct,
        // The split belongs only to a provider-REPORTED count; a local estimate has no category split.
        ...(acct.tokenSource === 'reported' && parsed.breakdown !== undefined
          ? { tokenBreakdown: parsed.breakdown }
          : {}),
        // Surface the session id so an authoring caller can resume its own session on a revise
        // round. A goaly-MINTED id is authoritative (we set it — immune to the ambient pin); a
        // CLI-reported id is trusted only when it is neither the unknown sentinel nor the ambient id.
        ...(minted !== undefined
          ? { sessionId: minted }
          : parsed.sessionId !== undefined &&
              parsed.sessionId !== this.#codec.unknownSession &&
              parsed.sessionId !== ambientSessionId()
            ? { sessionId: parsed.sessionId }
            : {}),
      },
    };
  }
}
