import type { RunId } from '../domain/ids';
import type { HarnessAdapter } from '../harness/adapter';
import type { LlmProvider } from '../llm/provider';
import type { PlanGate } from '../plan/plan-gate';
import type { SealGate } from '../compile/seal';
import type { DefectCorpusOptions } from '../defects/wiring';
import type { Logger, LogLevel } from '../log/logger';
import type { LogFs } from '../log/sinks';
import type { Observer } from '../observe/observer';
import type { FetchLike } from '../llm-client/openai-client';
import type { AutonomyLevel } from '../agent-cli/droid-codec';
import type { PhasedStreamSink } from '../agent-cli/stream';
import type { SandboxLauncher, SandboxProxy } from '../sandbox';
import type { SandboxPolicy } from '../sandbox/policy';
import type { ModelSelection } from './models';
import type { HarnessChoice, LlmProviderChoice, StepTimeouts } from './args';

/**
 * The composition root's OPTIONS surface: every knob `composeDeps` reads, from the CLI flags to the
 * test/embedder injection points. Extracted from `compose.ts` so the root stays about wiring seams
 * together, not about documenting each knob.
 */
export type ComposeOptions = {
  harness: HarnessChoice;
  workspaceRoot: string;
  /**
   * Workspace backing mode (ADR 0018). `git` or `file` are used as-is; `auto` resolves to `git`
   * when `workspaceRoot` is inside a git work tree and `file` otherwise.
   */
  workspaceMode?: 'git' | 'file' | 'auto';
  runId: RunId;
  /** Override the LLM provider (tests inject a FakeLlm; production uses the CLI provider). */
  llm?: LlmProvider;
  /**
   * Which provider runs the LLM workflow steps (judge / approver / compiler). Default: FOLLOWS
   * the harness ({@link defaultLlmProvider}), so a `--generate` bar is authored by the tool the
   * user actually picked — never unconditionally `claude`.
   */
  llmProvider?: LlmProviderChoice;
  /**
   * `--harness-autonomy`: how much the WRITE-role CLI may do, for harnesses that gate privileged
   * actions behind a tier (droid's `--auto`). Absent ⇒ the codec's own least-privilege default.
   * Deliberately NOT applied to the read-only LLM provider below: a judge/approver/compiler must
   * never be able to mutate the tree it is judging, whatever the worker is allowed to do.
   */
  harnessAutonomy?: AutonomyLevel | undefined;
  /** Raw model-selection flags; resolved into per-seam models via the cascade. */
  models?: ModelSelection;
  /** Per-step subprocess timeouts (harness / LLM steps / verify command). Each absent ⇒ default. */
  timeouts?: StepTimeouts;
  /**
   * Opt-in OS-isolation policy (issue #9). Absent / `mode: 'none'` ⇒ identity passthrough, so the
   * harness and verifier execs are byte-for-byte the current calls. Any other mode is detected
   * fail-closed: if the requested mechanism is absent the run refuses to start.
   */
  sandbox?: SandboxPolicy;
  /** Inject the sandbox launcher directly (tests); bypasses host detection from {@link sandbox}. */
  sandboxLauncher?: SandboxLauncher;
  /**
   * The running egress proxy when the sandbox policy uses an allowlist (issue #39). Started at the
   * composition edge (main.ts) before deps are composed and torn down after the run; threaded into
   * both jailed seams so they pin their proxy env vars at it. Absent ⇒ no allowlist active.
   */
  egressProxy?: SandboxProxy;
  /**
   * Diff baseline (issue #47): the git ref/SHA `diff()` (and thus Sign-off) compares the working tree
   * against, instead of `HEAD`. The CLI validates it resolves fail-closed BEFORE composing; here it
   * is just adopted onto the workspace. Absent ⇒ baseline stays `HEAD` (behavior unchanged).
   */
  baseline?: string;
  /**
   * Preferred directory (relative to the workspace root) for compiler-authored verification files
   * (issue #52). Threaded to the compiler as authoring guidance; absent ⇒ the compiler chooses an
   * idiomatic location. Authored files are registered in `.git/info/exclude` either way.
   */
  verifyDir?: string;
  /**
   * The cross-run DEFECT CORPUS (issue #122): `--no-defect-corpus` / `--defect-corpus <path>`.
   * Absent ⇒ enabled at `~/.goaly/defects.jsonl`. Both ends are wired from ONE resolution below —
   * the writer the Driver hands to a `CONTRACT_DEFECTIVE` adjudication, and the bounded
   * "do not author these" section the compiler injects. Fail-open: a missing/corrupt corpus
   * degrades to exactly today's behavior.
   */
  defects?: DefectCorpusOptions;
  /**
   * Phased decomposition (issue #48): the `--plan-file <path>` that sources a structured plan instead
   * of authoring one with the LLM. When set (and `config.phased`), a {@link StaticPlanner} reads it;
   * absent ⇒ the {@link AgentPlanner} authors the plan. Ignored when `config.phased` is false.
   */
  planFile?: string;
  /** Where run logs live. Default `<workspaceRoot>/.goaly` (excluded from diffHash). */
  stateDir?: string;
  /** Minimum diagnostic log level. Default `info`. */
  logLevel?: LogLevel;
  /** Override the diagnostics file path. Default `<stateDir>/<runId>/goaly.log`. */
  logFile?: string;
  /** Disable the diagnostics file sink (console only). */
  noLogFile?: boolean;
  /** Disable the console sink (file only) — handy in tests to keep stderr quiet. */
  noLogConsole?: boolean;
  /** Inject a fully-built logger (tests); bypasses the level/file options above. */
  logger?: Logger;
  /** Inject the log filesystem (tests) so diagnostics never touch disk. */
  logFs?: LogFs;
  /** Inject the clock source for log timestamps (tests). */
  now?: () => number;
  /**
   * Enable the `--stream` live view (issue #23): render the harness run AND the LLM steps'
   * intermediate turns to stderr, phase-tagged. Opt-in; off by default.
   */
  stream?: boolean;
  /** Override where the `--stream` renderer writes (tests capture it; default `process.stderr`). */
  streamWrite?: (line: string) => void;
  /**
   * Embedder hook (issue #23): subscribe to every phase-tagged stream event (the agent run and the
   * compile / judge / approve steps). Composed alongside the live view and the debug logger, then
   * threaded into the harness (via `DriverDeps.onStreamEvent`) and the LLM-step providers.
   */
  onStreamEvent?: PhasedStreamSink;
  /**
   * Durable stream transcript (issue #28): persist every phase-tagged stream event as canonical
   * JSONL to a per-run file for offline replay. `streamTranscript: true` writes to the default
   * `<stateDir>/<runId>/stream.jsonl`. Opt-in; a SEPARATE file from the run log — never the state
   * replay source — and fail-closed (a write failure degrades to "no transcript").
   */
  streamTranscript?: boolean;
  /** Override the stream-transcript path (implies {@link streamTranscript}). Default next to the run log. */
  streamFile?: string;
  /**
   * Enable the read-only `--explain` observer (issue #8): a side-LLM that narrates the frozen
   * contract, each verifier-ladder run, and the terminal outcome in plain language. Opt-in; off by
   * default. Strictly advisory — built on an UNMETERED read-only provider so its spend never enters
   * the run budget and it can never influence the contract, the ladder, DECIDE, or the two-key DONE.
   */
  explain?: boolean;
  /** Override where the observer writes its summaries (tests capture it; default `process.stderr`). */
  explainWrite?: (text: string) => void;
  /** Inject the observer directly (tests); bypasses building one from {@link explain}. */
  observer?: Observer;
  /**
   * OpenAI-compatible endpoint base URL for `--harness goaly-code` / `--llm-provider openai`. Required for
   * those targets; absent ⇒ they fail closed at composition (a typed {@link EndpointConfigError}).
   */
  baseUrl?: string;
  /** Resolved bearer token for that endpoint (read from env at the composition edge). May be absent. */
  llmApiKey?: string;
  /** Inject the HTTP fetch for the OpenAI client (tests/embedders); default binds global fetch. */
  llmFetch?: FetchLike;
  /** Override the goaly-code harness per-run turn cap. */
  goalyCodeMaxTurns?: number;
  /**
   * Follow-up seed (Capability C, `--from-run`): a deterministic COMPACTION of a prior run, woven
   * into the compiler's (and, when phased, the planner's) authoring `feedback` so the new run's
   * frozen contract is authored AWARE of what just happened. Pure wiring at the seam — the freeze is
   * unaffected (every attempt is still frozen + Sealed on its own). Absent ⇒ a normal fresh run.
   */
  followupSeed?: string;
  /**
   * Inject the Seal gate (ADR 0015: the goaly-ui browser gate; tests inject fakes). A gate
   * IMPLEMENTATION, never a bypass — the contract still freezes and `SEAL_DECIDED` still logs
   * (invariant #5). Absent ⇒ the classic selection on `config.autonomous`.
   */
  sealGate?: SealGate;
  /** Inject the plan-Seal gate (phased runs), same rules as {@link sealGate}. */
  planGate?: PlanGate;
  /**
   * Inject the harness adapter per workspace root (tests/embedders) — bypasses {@link harness}
   * selection. The FACTORY shape (not a single adapter) exists for EXPERIMENTAL parallel waves,
   * where each wave child composes its own deps rooted at its worktree: the factory receives that
   * root so a scripted test harness can write into the right tree.
   */
  harnessFactory?: (workspaceRoot: string) => HarnessAdapter;
};
