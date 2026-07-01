# Adding a harness

A "harness" is a coding agent you can drive headlessly (Claude Code, Codex, Aider, Cursor CLI,
your own). Adding one is deliberately **one module** — an `AgentCliCodec` that holds *all* of one
CLI's quirks in a single place. This guide shows exactly what to map and how. To probe an unfamiliar
CLI first, use the [`investigate-harness`](../.claude/skills/investigate-harness/SKILL.md) skill — it
produces the flag/field/status mapping this guide asks for.

## At a glance

**You write one file** — `src/agent-cli/<name>-codec.ts` — and **add one line** to a registry:

1. **Discover** three things about the CLI: how to run one headless turn, how to read its result,
   and how to resume a session. (Per-turn streaming is a fourth, optional.)
2. **Map** them into an `AgentCliCodec`: two argv dialects (write vs read-only), a field extractor,
   a status mapping, and an optional stream extractor.
3. **Register** it: add the literal to the `AgentCli` union + one `codecFor` case, and allow it in
   the arg parsers.
4. **Test** it: add the adapter to the shared contract matrix, plus codec-level tests; keep
   `npm run typecheck` and `npm test` green.

**The shared core already owns** the tolerant JSON/JSONL parse, the subprocess dance (timeouts,
output caps, process-group kill), diff hashing, verifier execution, the streaming tap, and the
sandbox wrap — all *outside* your codec. So a codec is **just one CLI's quirks**, never plumbing.

**Two roles, one codec.** The same module drives both the write-mode harness (it edits the tree)
*and* the read-only LLM steps (judge / approver / compiler / planner — which must never edit). The
only difference is the argv dialect: `harnessArgs` (writable) vs `readonlyArgs` (read-only).

The rest of this guide is the detail behind each step, ending with a copy-paste **skeleton** and a
**checklist**. In a hurry, skim those two and refer back to the numbered mapping sections as needed.

> **Two adapter shapes.** Most of this guide covers the **codec-backed** shape: you wrap an external
> CLI. There is a second shape — the **goaly-code harness** (SDK-native, non-codec; `--harness goaly-code`), where goaly is the
> agent itself and drives an OpenAI-compatible endpoint through its own tool-use loop, no CLI
> installed. Both implement the same seam #1 (`HarnessAdapter`). If you are wrapping a CLI, read on; if
> you are adding a direct API/SDK target, jump to [the goaly-code harness](#the-goaly-code-harness-sdk-native-non-codec).

## The contract

The orchestrator-facing seam is one method:

```ts
// src/harness/adapter.ts
interface HarnessAdapter {
  readonly name: string;
  run(prompt: string, sessionId?: SessionId, onEvent?: AgentEventSink): Promise<HarnessRunResult>;
}

// src/domain/events.ts
type HarnessRunResult = {
  output: string;
  sessionId: SessionId;
  status: 'completed' | 'crashed' | 'truncated' | 'timeout';
  tokensUsed?: number;
};
```

You almost never implement `run()` by hand. The generic `AgentCliHarness`
(`src/harness/agent-cli-harness.ts`) already implements the seam for any CLI — it spawns, taps the
stream, and classifies through the shared `runCodecHarness`. What you write is the **codec** it
consumes:

```ts
// src/agent-cli/codec.ts
interface AgentCliCodec {
  readonly name: string;            // "myagent" — short id for logs
  readonly command: string;         // the binary to spawn, e.g. "myagent"
  readonly unknownSession: string;  // safe sentinel session id, e.g. "myagent-unknown". The shared
                                    // core never threads this sentinel into a resume — a turn that
                                    // yields no real session (e.g. a timeout) just starts fresh next
                                    // turn instead of `<cli> --resume <sentinel>` (which would crash).
  readonly promptOnStdin: boolean;  // also write the prompt to stdin (claude) vs argv-only (codex/droid)

  readonly fieldExtractor: FieldExtractor;          // final-result field mapping (§1)
  readonly streamExtractor: StreamEventExtractor;   // per-turn event mapping (§3, optional)

  // The two argv DIALECTS — write-mode (harness role) and read-only (LLM role). `stream` asks for
  // per-turn JSONL where the CLI distinguishes it from its normal structured output.
  harnessArgs(opts: { prompt: string; model: string | undefined; sessionId?: SessionId; stream: boolean }): string[];
  readonlyArgs(opts: { prompt: string; model: string | undefined; stream: boolean }): string[];

  parse(stdout: string): AgentOutput | null;        // tolerant final-result parse; never throws
  classify(input: CodecClassifyInput): HarnessRunResult;  // process outcome → status (§2)

  // OPTIONAL (§4): how to CONTINUE this CLI's own interactive session after a goaly run ends —
  // `goaly runs resume-cmd <id>` and the end-of-run banner. Returns the command + an optional caveat.
  interactiveResume?(id: SessionId): { command: string; caveat?: string };
}
```

That's the whole unit of work, and it's the answer to **locality**: a CLI's two argv dialects, its
extractors, and its status mapping live in *one* module instead of smeared across five. The same
codec is consumed by **both** roles a CLI can play — the write-mode `HarnessAdapter` (seam #1, via
`harnessArgs` + `classify`) and the read-only `AgentCliLlmProvider` (the judge/approver/compiler LLM
role, via `readonlyArgs` + the same extractors) — so there is no `llm → harness` coupling.

### What the codec MUST honor

1. **Two argv dialects.** `harnessArgs` runs the agent in a **writable** mode (it must be able to edit
   the tree); `readonlyArgs` runs it in a **read-only** mode (it must never edit). See below.
2. **Parse stdout tolerantly** — partial output, crashes, and non-JSON are *normal*, not errors.
3. **Thread the session id** out (so the next iteration resumes the same conversation).
4. **Map the outcome to a `status`** in `classify`, returning a Zod-parsed `HarnessRunResult`.
5. **Never throw.** Any failure becomes `status: 'crashed' | 'truncated' | 'timeout'`. The reducer
   treats a non-`completed` run as a failed iteration and feeds it back — it must not crash the loop.

### What the codec must NOT do

- **Don't compute `diffHash`.** The shared `Workspace` does that (so stuck-detection works on any
  harness for free). It's not even in `HarnessRunResult`.
- **Don't run the verifier.** Verification is "run this command in the workspace," identical
  everywhere — outside every codec.
- **Don't re-implement the subprocess dance.** `runProcess` (`src/util/spawn.ts`) owns it once —
  output cap, timeout, process-group kill, never-reject — and `defaultAgentExec` wraps it for you.

## The three things to discover (the lowest common denominator)

Every serious harness exposes these; find each for your target:

| Capability | Claude Code | Codex | What you need |
|---|---|---|---|
| Headless / print invocation | `claude -p "<prompt>"` | `codex exec --full-auto "<prompt>"` | how to run one non-interactive turn |
| Write autonomy *(harness role)* | `--permission-mode acceptEdits` | `--full-auto` | let the **write** role apply edits — both CLIs deny writes headlessly by default; the read-only LLM role omits it |
| Structured output | `--output-format json` | `--json` (JSONL stream) | a machine-readable result |
| Session resume | `--resume <id>` | `codex exec resume <id>` | continue the same conversation |
| Streaming turns *(optional)* | `--output-format stream-json --verbose` | `--json` (already a JSONL stream) | per-turn events for live observability (issue #23) |

If a harness lacks structured output, parse its text output tolerantly and synthesize a session id.
If it lacks resume, return a stable session id and accept that each turn is cold (note it). If it has
no per-turn streaming mode, **skip the stream mapping** — reuse `flatStreamExtractor` and the run is
unaffected (a tool that only emits a final envelope still degrades to a couple of events).

**The two argv dialects are the crux.** `harnessArgs` must run in a writable mode (the agent *drives*
edits), and `readonlyArgs` must forbid edits (a judge/approver/compiler must never touch the tree it
is judging). Some CLIs are read-only by default and need an explicit write flag: `codex exec` runs in
a read-only sandbox unless you pass `--full-auto` (its workspace-write alias), so codex's
`harnessArgs` passes it and its `readonlyArgs` passes `--sandbox read-only` instead. If you forget the
write flag, the agent can diagnose but never apply a fix and every iteration no-diffs.

## The mappings you define inside the codec

The shared core (`src/agent-cli/`) already owns the **envelope machinery** — for the FINAL result
(`output.ts`: the whole-object / amid-noise / JSONL walk, latching the **first** session id seen,
keeping the **last** text-bearing line, accruing token counts) and, for the live STREAM
(`stream.ts`: a `StreamTap` that buffers partial lines across stdout chunks, parses each completed
JSONL line, Zod-validates events at the seam, and forwards them to a sink) — and **never throws**.
You supply the small, tool-specific pieces.

### 1. Field mapping — a `FieldExtractor`

A `FieldExtractor` is `(obj) => { text?, sessionId?, tokens?, breakdown?, isError? }`: pull those
fields out of **one** parsed JSON object by your CLI's key names. `tokens` is the all-inclusive total
(input + output + cache-read + cache-write, or a provider `total_tokens`); `breakdown` is the
optional per-category split (`{ input?, output?, cacheRead?, cacheWrite? }`) the cost overlay prices
per-rate. The codec's `parse` is then a one-liner over the shared core.

```ts
import { parseAgentOutput, flatExtractor, type FieldExtractor } from './output';

// If your envelope is FLAT (text under result/text/response, session under session_id/sessionId,
// tokens in a `usage` block — input/output AND cache_read/cache_creation are read for you) you
// don't write one at all — reuse the shared factory:
const fieldExtractor = flatExtractor();                  // claude & droid use exactly this
// droid only adds a soft-error flag: flatExtractor({ errorKey: 'is_error' })

// Write a CUSTOM extractor only if your shapes are nested (see `codexExtractor` in codex-codec.ts,
// which walks message/content[]/delta and thread-id session keys):
const fieldExtractor: FieldExtractor = (obj) => ({ /* ...pull your fields... */ });

// In the codec: parse(stdout) { return parseAgentOutput(stdout, fieldExtractor); }
```

An extractor must **never throw**, and should emit `text` only when the object actually carries a
result — the flat extractor treats `''` as present (text-bearing); codex requires non-empty (your
call what counts as "no text"). `parseAgentOutput` returns `null` when nothing usable parsed.

### 2. Status mapping — `classify(input)`

`classify` turns a finished process into a Zod-parsed `HarnessRunResult`. For the standard policy,
delegate to the shared `classifyFlatRun({ parsed, code, stderr, timedOut, sessionId, unknownSession,
estimator? })` (from `src/agent-cli/codec.ts`, used by claude **and** droid). The optional
`estimator` (issue #24) is the `StreamTokenEstimator` `runCodecHarness` threads in when the run
streamed: when the parsed envelope carries **no** `usage`, `classifyFlatRun` falls back to its local
estimate and stamps `tokenSource: 'estimated'` (vs `'reported'` for a real count). A non-streaming run
simply reports unknown spend, exactly as before:

| Condition | status |
|---|---|
| timed out (killed for exceeding the wall-clock budget) | `timeout` (salvages any parsed text) |
| exited non-zero (or signal-killed) | `crashed` |
| exit 0, parseable, non-empty result | `completed` |
| exit 0 but empty / unparseable result | `truncated` |
| a soft `isError` flag on a clean exit | `truncated` |

```ts
import { classifyFlatRun } from './codec';

classify(input) {
  return classifyFlatRun({
    parsed: this.parse(input.stdout),
    code: input.code,
    stderr: input.stderr,
    timedOut: input.timedOut,
    sessionId: input.sessionId,
    unknownSession: this.unknownSession,
    estimator: input.estimator,
  });
}
```

If your CLI needs a **different** policy — codex, for instance, maps no-parse → `crashed` and
non-zero-with-text → `truncated` — write a bespoke `classify` in your codec instead (see
`codexCodec.classify` in `codex-codec.ts`). Either way, always construct the result through
`HarnessRunResult.parse(...)` so a bad mapping is caught at the boundary, and resolve the session with
`coerceSessionId(candidate, this.unknownSession)` (from `src/domain/ids.ts`) so an absent/hostile id
falls back safely instead of throwing.

### 3. Stream mapping — a `StreamEventExtractor` *(optional, issue #23)*

The **streaming sibling of the field mapping**. Where the `FieldExtractor` converges your tool's
*final* output into one `AgentFields` abstraction, a `StreamEventExtractor` converges your tool's
*intermediate turns* into one **canonical, tool-neutral event taxonomy** — the same abstraction-first
discipline, so no tool-specific event shapes ever leak past the parser. If your CLI has no per-turn
streaming mode, reuse `flatStreamExtractor` (a final-envelope-only CLI degrades to `session → message
→ usage → done`); the run is unaffected.

The target is `AgentStreamEvent` (`src/agent-cli/stream.ts`) — a Zod-validated discriminated union,
a **superset** you map INTO (omit the variants your tool can't produce):

```ts
type AgentStreamEvent =
  | { kind: 'session';     sessionId: string }
  | { kind: 'message';     text: string; delta?: boolean }               // assistant text (full or incremental)
  | { kind: 'reasoning';   text: string }                                // thinking, where exposed
  | { kind: 'tool_use';    id?: string; name: string; input?: unknown }  // tool / command invocation
  | { kind: 'tool_result'; id?: string; output: string; exitCode?: number; isError?: boolean }
  | { kind: 'usage';       inputTokens?: number; outputTokens?: number; cachedTokens?: number; totalTokens?: number }
  | { kind: 'done';        status: string };                             // turn / run complete
```

A `StreamEventExtractor` is `(obj) => AgentStreamEvent[]`: map **one** parsed JSONL line to zero or
more canonical events. Return `[]` for lines you don't recognize. It need not be defensive — the
`StreamTap` Zod-validates every event you return and drops any that don't fit, and guards the call so
a throw degrades to "no events for this line" (fail-closed; observability never crashes a run).

```ts
import { sdkStreamExtractor, flatStreamExtractor, type StreamEventExtractor } from './stream';

// If your tool emits the ANTHROPIC AGENT-SDK stream-json envelope (system/assistant/user/result
// events) you don't write one at all — reuse the shared factory (claude & droid use exactly this):
const streamExtractor = sdkStreamExtractor();                  // droid adds { errorKey: 'is_error' }

// If your tool only emits a single FINAL result object, degrade with the flat factory
// (session → message → usage → done):
const streamExtractor = flatStreamExtractor({ errorKey: 'is_error' });

// Write a CUSTOM extractor only for a bespoke JSONL shape (see `codexStreamExtractor` in codex-codec.ts,
// which maps thread.started → session, item.completed agent_message → message, command_execution →
// tool_use + tool_result, turn.completed → usage + done):
const streamExtractor: StreamEventExtractor = (obj) => { /* ...map one line... */ return []; };
```

You don't wire the `StreamTap` yourself — `runCodecHarness` builds it from `codec.streamExtractor`
whenever the caller passes `onEvent`, feeds it each stdout chunk, `end()`s it, and tees it into the
issue-#24 token estimator. Your only streaming-aware choice is in `harnessArgs`/`readonlyArgs`: when a
CLI's stream mode is a *different flag* (claude & droid switch `--output-format json` →
`stream-json` when streaming; codex's `--json` is already a stream), branch on the `stream` parameter.
The **final-result parse is unchanged** — `fieldExtractor` still recovers the same `output` from the
stream's closing line, so a non-streaming caller sees byte-identical behavior. See
`src/llm/streaming.test.ts` and `src/agent-cli/codec.test.ts` for the test pattern.

### 4. Interactive-resume hint — `interactiveResume(id)` *(optional, Capability A)*

After a goaly run ends, `goaly runs resume-cmd <id>` (and the end-of-run banner) prints how to
**continue that run's session in the CLI's OWN interactive mode**. Each CLI's interactive-resume
phrasing differs from the headless `harnessArgs` goaly drives, so it lives per-codec (locality). Add
`interactiveResume(id)` returning the command string and, when honest, a `caveat`:

```ts
interactiveResume(id) {
  return { command: `myagent --resume ${id}` };
  // ...or, when the interactive form differs / is approximate, add a caveat:
  // return { command: `myagent resume ${id}`, caveat: 'interactive resume differs from headless exec' };
}
```

The four bundled codecs map it as: claude → `claude --resume <id>`; codex → `codex resume <id>`
(caveat: differs from `exec`); droid → `droid --session-id <id>`; pi → `pi --continue` (caveat: it
resumes the latest *cwd* session only, so the id is not addressable). It is **optional** — a codec
that omits it makes `resume-cmd` report a typed "no resume command" for that harness. The
`HarnessChoice`→codec bridge and the typed result live in `src/cli/resume-cmd.ts` (`resumeHint`);
goaly-code (no external CLI) is routed there to the follow-up path instead (`--from-run
--inherit-session`).

## Skeleton (copy `src/agent-cli/claude-codec.ts` and adapt)

```ts
// src/agent-cli/myagent-codec.ts
import { parseAgentOutput, flatExtractor } from './output';
import { sdkStreamExtractor } from './stream';
import { classifyFlatRun, type AgentCliCodec } from './codec';

const UNKNOWN_SESSION = 'myagent-unknown';
const fieldExtractor = flatExtractor();         // or a custom FieldExtractor (§1)
const streamExtractor = sdkStreamExtractor();   // or flatStreamExtractor / a custom one (§3)

export const myagentCodec: AgentCliCodec = {
  name: 'myagent',
  command: 'myagent',
  unknownSession: UNKNOWN_SESSION,
  promptOnStdin: false,                          // true if the CLI also reads the prompt from stdin
  fieldExtractor,
  streamExtractor,
  harnessArgs({ prompt, model, sessionId, stream }) {
    // WRITE mode — the agent must be able to edit the tree. Flags first, prompt last.
    const args = ['exec', '--output-format', stream ? 'stream-json' : 'json', '--write-flag'];
    if (model !== undefined) args.push('--model', model);          // model is wiring, not contract
    if (sessionId !== undefined) args.push('--session-id', sessionId);
    args.push(prompt);
    return args;
  },
  readonlyArgs({ prompt, model }) {
    // READ-ONLY mode — a judge/approver/compiler must NEVER edit the tree.
    return ['exec', '--read-only', ...(model !== undefined ? ['--model', model] : []), prompt];
  },
  parse(stdout) {
    return parseAgentOutput(stdout, fieldExtractor);
  },
  classify(input) {
    // Standard policy. For codex's inverted mapping, write a bespoke classify (see codex-codec.ts).
    return classifyFlatRun({
      parsed: parseAgentOutput(input.stdout, fieldExtractor),
      code: input.code,
      stderr: input.stderr,
      timedOut: input.timedOut,
      sessionId: input.sessionId,
      unknownSession: UNKNOWN_SESSION,
      estimator: input.estimator,                // issue #24: estimate spend from streamed turns
    });
  },
  interactiveResume(id) {                          // §4 (optional): continue the CLI session
    return { command: `myagent --resume ${id}` };
  },
};
```

The subprocess is **not** your problem: `AgentCliHarness` builds the default exec for you with
`defaultAgentExec(codec.command, timeoutMs, codec.promptOnStdin)`, which spawns the real binary via
the shared `runProcess` (output cap, timeout, process-group kill, never-reject). Tests inject a fake
`AgentExecFn` instead.

**The sandbox is not your problem either.** When `--sandbox` is on, `compose.ts` wraps the injected
`exec` around your codec's `command`/argv at the composition root (`src/sandbox/`, ADR 0007) — it
rewrites `[command, ...args]` into the jailed invocation (bwrap / container) before spawning. This is
**transparent to codec authors**: you write your `harnessArgs`/`readonlyArgs` exactly as you would
unsandboxed and **do nothing** for the sandbox; the launcher prefix is added (or, by default, is an
identity passthrough) entirely outside the codec.

Supporting `--model` is optional but cheap: thread the `model` argument into your `*Args` (before the
prompt positional). The composition root passes the resolved harness model in for you. The timeouts
are handled the same way — `makeHarness` threads both the wall-clock `--harness-timeout-ms` and the
idle/heartbeat `--harness-idle-timeout-ms` (issue #56) into `AgentCliHarness` (constructor `opts`
already carry `{ model?, timeoutMs?, idleTimeoutMs?, cwd? }`), and you write no flag parsing for either.

**Provider-agnostic CLIs (e.g. `pi`).** A tool that drives any model from any provider needs to pick
*both*, but goaly's seam is a single `--model` string — do **not** add a `--provider` flag. If the
CLI's `--model` accepts a `provider/id` form (pi does: `--model "anthropic/claude-opus-4-8"`), thread
it through unchanged and the one string selects both; omit it and the tool falls back to its own
configured default. Credentials stay the operator's responsibility (env / the tool's own config) —
the same boundary `claude` and `codex` assume. See `pi`'s codec (`src/agent-cli/pi-codec.ts`) for a
worked example, including the `--continue` headless-resume pattern (a tool with no resume-by-id flag)
and a `--tools`-based autonomy split (write role keeps `edit`/`write` but not `bash`, so it can't
`git commit` and empty the diff; the read-only role drops both).

## Register it (one map + the parsers)

There is **one** name→codec map, `codecFor` in `src/agent-cli/registry.ts`. Both roles a CLI can play
resolve through it — the write-role `AgentCliHarness(codecFor(choice))`, the sandbox exec, and the
read-only `AgentCliLlmProvider({ codec: codecFor(choice) })` — so the codec is registered in exactly
one place and the harness and LLM-provider paths can never drift.

```ts
// src/agent-cli/registry.ts — add the literal to AgentCli + one case to codecFor
import { myagentCodec } from './myagent-codec';
export type AgentCli = 'claude' | 'codex' | 'droid' | 'pi' | 'myagent';
// ...inside codecFor(cli):
case 'myagent': return myagentCodec;
```

`HarnessChoice` (`= AgentCli | 'fake' | 'goaly-code'`) and `LlmProviderChoice` (`= AgentCli | 'openai'`)
pick up the new value from the union automatically; allow it in `parseHarness`/`parseLlmProvider`
(`src/cli/args.ts`). That's
the whole write-role wiring — `makeHarness` is already generic (`new AgentCliHarness(codecFor(choice),
opts)`), and `opts` carries `{ model?, timeoutMs?, idleTimeoutMs?, cwd? }`.

Optionally export `myagentCodec` from `src/index.ts` for embedders.

## Optional: also use the tool for the LLM steps (compiler / judge / approver / planner)

A harness *drives* the agent. The LLM workflow steps — authoring the verification (compiler), the
LLM-judge rung, the Sign-off approver, and (for `--phased`) the **planner** that authors the frozen
plan of sub-goals — are a **separate** seam, `LlmProvider`:

```ts
// src/llm/provider.ts
type LlmCompletion = { text: string; tokensUsed?: number };
interface LlmProvider {
  readonly name: string;
  complete(req: { system?: string; prompt: string; temperature?: number }): Promise<LlmCompletion>;
}
```

It is deliberately **not** the same interface as `HarnessAdapter` (Interface Segregation): `run()`
is session-threaded and **may edit the working tree**; `complete()` is a stateless, **read-only**
`prompt → {text, tokensUsed?}`. A judge or approver that mutated the tree would corrupt the very diff
it is judging. The good news: **you already wrote everything it needs** — your codec's `readonlyArgs`
dialect and `fieldExtractor`/`streamExtractor`.

`complete()` returns an `LlmCompletion`, not a bare string: `text` is the result, and the **optional
`tokensUsed`** (with a `tokenSource: 'reported' | 'estimated'` marker, plus an optional per-category
`tokenBreakdown` for a reported count) feeds the
[per-run spend report](../README.md#per-run-spend-report). `AgentCliLlmProvider` fills it in from the
same `usage` block your `FieldExtractor` already reads (cache buckets included); and when you wire a
`streamExtractor`, it
**estimates** the spend from the streamed turns whenever the CLI reports no usage (issue #24) — all
internal. Surfacing nothing is still fine — a missing count degrades to "unknown", never a crash.

`AgentCliLlmProvider` (`src/llm/agent-cli-provider.ts`) does the plumbing — it takes your **whole
codec** and builds the read-only argv (`codec.readonlyArgs`), delivers the prompt on stdin or argv
per `codec.promptOnStdin`, parses with `codec.fieldExtractor` via the same shared `parseAgentOutput`,
streams via `codec.streamExtractor`, and returns `{text, tokensUsed?}` or **fails closed** (throws on
empty/unparseable output, invariant #4). Because it is driven entirely by the codec, **there is no
per-provider registration** — `makeLlmProvider` is generic:

```ts
// src/cli/compose.ts — ALREADY generic; no edit needed when you add a CLI:
return new AgentCliLlmProvider({ codec: codecFor(choice), /* model, timeoutMs, onEvent */ });
```

So once your codec is in `codecFor` (above) and the value is in the `AgentCli` union + parsers, the
LLM-provider role works automatically — provided your `readonlyArgs` is genuinely read-only.

**The read-only invocation is mandatory.** Find the flag that forbids edits: codex uses
`--sandbox read-only`; droid's `exec` is read-only *unless* you pass `--auto`, so its `readonlyArgs`
omits it. **If your CLI has no read-only mode, do not wire it as a provider** — an agentic judge that
can write the tree breaks the frozen-bar guarantee.

That's it. The resolved per-step model is threaded in for you, and the cascade
(`--judge-model`/`--approver-model`/`--compiler-model` → `--llm-model` → `--model` → tool default)
applies automatically — your provider just receives a `model` string or `undefined`.

**Caveats to document.** Each `complete()` is a full (read-only) agent turn, and the judge calls it
`quorum` times (default 3) per iteration — heavier than a one-shot completion API, which is why
`claude` stays the default. And model names are tool-specific: align `--llm-provider` with the model
you pass, or the cascade may hand a name from one tool's namespace to another (`claude --model
<a-codex-model>`).

**Test the provider** by constructing `new AgentCliLlmProvider({ codec: myagentCodec, exec })` with a
fake `exec` (see `src/llm/agent-cli-provider.test.ts`): assert it returns your parsed `text` (and
`tokensUsed` when the `usage` block is present), that the argv carries your read-only flag (and
`--model` when set), that the prompt rides on stdin or argv per `promptOnStdin`, and that
hostile/empty output **throws** (fail closed). Test your codec's argv dialects directly (see
`src/agent-cli/<name>-codec.test.ts` and `src/agent-cli/codec.test.ts`).

## The goaly-code harness (SDK-native, non-codec)

Everything above wraps an external CLI: a CLI fills the whole agent loop (tool-use, file editing,
context, session/resume, streaming, token accounting) for free, so a codec is ~150 lines. The
**goaly-code harness** (`src/goaly-code/`, `--harness goaly-code`) takes the other path — **goaly becomes the
coding agent** and owns that loop, driving an OpenAI-compatible chat-completions endpoint directly.
It is the **first non-codec adapter**: there is no `AgentCliCodec`, no subprocess, no CLI to install
— only Node's built-in `fetch`. It is purely additive behind `--harness goaly-code`; the codec harnesses are
byte-for-byte unchanged.

It implements the **same seam #1** (`HarnessAdapter.run(prompt, sessionId?, onEvent?)`), so the
orchestrator can't tell it apart from a codec harness. The same `Workspace` (diff/diffHash/run), the
same sandbox seam, the same `AgentStreamEvent` streaming taxonomy, and the same `TokenBreakdown`
accounting all apply unchanged.

### Module layout

```
src/llm-client/
  schema.ts          # Zod for the chat-completions request/response envelope (the wire seam, #6)
  openai-client.ts   # OpenAiClient implements LlmClient: fetch + Zod, base-url, auth, retries, usage→TokenBreakdown
src/llm/
  openai-provider.ts # read-only OpenAiLlmProvider on the same client (judge/approver/compiler — Slice 0)
src/goaly-code/
  harness.ts         # GoalyCodeHarness implements HarnessAdapter (seam #1): resolve session → loop → persist → typed result
  loop.ts            # the tool-use agent loop (turn cap / deadline / fail-closed / event emit / token sum)
  tools.ts           # the minimal tool set + dispatchTool (the never-crash guarantee) + toApiTools
  edit.ts            # applyEdit — exact → whitespace-tolerant, with actionable failure strings
  fs-host.ts         # NodeToolHost: path-guarded fs + the INJECTED sandboxed run_shell
  session-store.ts   # FileSessionStore (resume) + InMemorySessionStore; fail-closed read
  prompt.ts          # the goaly-tuned system prompt
```

### The transport (`LlmClient`) — shared with the `openai` provider

The HTTP layer is one place (`OpenAiClient`): `fetch` + Zod, base-url + bearer auth, bounded retries
(network / 429 / 5xx, then a fail-closed throw), per-request `AbortController` timeout, and `usage`
→ `TokenBreakdown` (OpenAI's `prompt_tokens` is cache-inclusive, so cached tokens are split out into
`cacheRead`). Both `fetch` and the backoff `sleep` are injectable, so unit tests touch no network and
no real timer. It returns a **normalized** `ChatResult` (minted tool-call ids, parsed usage) so the
loop never re-handles wire quirks.

The same client backs the read-only `OpenAiLlmProvider` (`--llm-provider openai`): a single
`[system?, user]` exchange with **no tools**, so it is structurally read-only — it fails closed
(throws) when the endpoint returns no text (invariant #4), the same guarantee a CLI provider gets
from its `readonlyArgs` dialect.

### The loop and its fail-closed contract (the part that matters)

`loop.ts` is the heart: call the model; append its turn; if it requested `tool_calls`, dispatch each
and feed results back; if it returned a final message or called `finish`, stop. The termination and
fail-closed mapping mirror `adapter.contract.test.ts`:

| condition | status |
|---|---|
| turn cap hit | `truncated` |
| wall-clock deadline reached | `timeout` |
| client throws (network / 5xx / malformed envelope, after retries) | `crashed` (→ pure `STUCK_HARNESS_CRASH`) |
| a throwing / invalid tool call | its error becomes the **tool result string** (never a crash) |
| final message / `finish` | `completed` |

The loop **never throws** out of `run()` — this is the single most important property and gets a
dedicated adversarial test. A throwing event sink is swallowed (streaming is pure observability).

### Tools, and why `edit_file` gets the heaviest test table

The tool set is minimal and every tool **Zod-validates its arguments at the seam** (invariant #6):
`read_file`, `list_dir`, `grep`, `write_file`, `edit_file`, `run_shell`, `finish`. `dispatchTool`
owns the never-crash guarantee — an unknown tool, non-JSON arguments, or a throwing handler all become
a result string the model can recover from.

`edit_file` is the make-or-break of harness *quality* (not safety): a naive exact-only replace
thrashes when the model copies text with a stray space or wrong indent. `edit.ts` is therefore a pure
function with a ladder — exact match first, then whitespace-tolerant line matching — and returns a
clear, actionable error for every failure (not found / not unique / empty / no-op). `write_file` is
the escape hatch. This is the largest determinant of how many iterations a run takes, so it carries
the heaviest unit-test table in the slice (`edit.test.ts`).

### Sandboxing at the tool grain (the key architectural difference)

A CLI harness is **one** opaque subprocess; the sandbox wraps the whole binary. The goaly-code harness is
**goaly's own process** making the API call, plus **many** shell subprocesses (one per `run_shell`).
So the untrusted surface shrinks to `run_shell`:

- the inference HTTP call is made by goaly itself, **un-jailed** — no change to how the endpoint is
  reached;
- **file edits go through goaly's own path-guarded writers** (`NodeToolHost`), not a subprocess;
- only `run_shell` is sandboxed, with the **same** launcher the codec harnesses use, at a *finer*
  grain. `compose.ts` injects the sandbox-wrapped shell into the host (keeping the harness network
  profile + full env); everything else in `goaly-code` is testable with a fake shell.

### Session persistence (resume, invariant #7)

The harness owns its conversation; the orchestrator only threads a `SessionId`. `FileSessionStore`
persists the message log keyed by that id (sanitized into a safe filename) and reloads it on resume,
appending the next prompt. It is fail-closed on read — a corrupt/missing/unparseable file degrades to
a fresh session (logged loudly), never a throw — and validates every message with the same Zod schema
the wire uses.

### Registration (precise)

- `src/cli/args.ts`: `HarnessChoice = AgentCli | 'fake' | 'goaly-code'`; `LlmProviderChoice = AgentCli |
  'openai'`; allow both in `parseHarness`/`parseLlmProvider`; add `--base-url <url>` and
  `--llm-api-key-env <NAME>` (default `OPENAI_API_KEY`); usage strings.
- `src/cli/compose.ts`: `makeHarness` is bypassed for `goaly-code` — `composeDeps` routes to `makeGoalyCodeHarness`
  (builds the `OpenAiClient`, the `NodeToolHost` with a sandbox-wrapped `run_shell`, and a
  `FileSessionStore`). `makeLlmProvider` gains an `openai` branch (a direct `OpenAiLlmProvider`). Both
  fail closed (`EndpointConfigError`) without a base URL / resolved model. `codecFor` is **untouched** (goaly-code
  is not a codec). `src/cli/main.ts` resolves the bearer token from `--llm-api-key-env` and catches
  `EndpointConfigError` for a friendly exit. `independence.ts` maps `goaly-code`'s family to `openai`.
- Tests: `args` parses the new flags; `compose.goaly-code.test.ts` builds a `GoalyCodeHarness` / `openai` provider
  and fails closed without config; `compose.goaly-code-e2e.test.ts` drives the **full pipeline** (real git +
  fs) with a fake HTTP endpoint to a verified DONE; the loop is proven with a scripted `LlmClient` and
  a fake host — **zero network, zero real shell**.

### Testing the goaly-code harness (no network, no shell)

Construct `new GoalyCodeHarness({ client, model, host, sessionStore })` with a **scripted `LlmClient`**
(returns canned `ChatResult`s or throws) and a **fake `ToolHost`**, then assert the seam invariants:
never throws, always a valid `HarnessRunResult`, every scenario (finish / final-text / client-throws /
timeout / truncate) maps to a sane status — mirroring `adapter.contract.test.ts`. Test `applyEdit`
directly (the heaviest table), `dispatchTool`'s fail-closed paths, `NodeToolHost` against a temp dir,
and the session store round-trip / fail-closed read. See `src/goaly-code/*.test.ts`.

## Test it (no real process)

Inject a fake `exec` and assert the seam invariants. The shared contract test in
`src/harness/adapter.contract.test.ts` runs every adapter through the same matrix — add yours (an
`AgentCliHarness` over your codec) to its `adapters` array so it's proven to **never throw**, always
return a valid `HarnessRunResult`, and map each scenario (success / non-zero / garbage / timeout /
exec-throws) to a sane status. Then add codec-specific tests for your `parse` (real-output samples →
fields), your two argv dialects, and your `classify` policy (see `src/agent-cli/codec.test.ts`). If
you implemented a non-trivial stream mapping, also add a streaming test (fake exec replays canned
JSONL through `onStdout` → assert ordered `AgentStreamEvent`s and an identical final result
with/without streaming) — see `src/harness/stream-extractors.test.ts` and `src/llm/agent-cli-provider.test.ts`.

## Checklist

- [ ] An `AgentCliCodec` in `src/agent-cli/<name>-codec.ts`: `fieldExtractor` (or the shared `flatExtractor`) + a `parse` over `parseAgentOutput`; the extractor never throws and emits `text` only for real results.
- [ ] Two argv dialects: `harnessArgs` runs **writable** (it can edit the tree); `readonlyArgs` runs **read-only**. Flags first, prompt last; `--model` (when set) before the prompt positional.
- [ ] `classify` never throws; uses `classifyFlatRun` (or a documented bespoke policy) and returns a `HarnessRunResult.parse(...)`d value; session id uses `coerceSessionId(..., this.unknownSession)`.
- [ ] Registered in `src/agent-cli/registry.ts` (the `AgentCli` union + one `codecFor` case) and allowed in `parseHarness`/`parseLlmProvider` (`src/cli/args.ts`); documented the assumed CLI contract in a header comment. (`makeHarness`/`makeLlmProvider` are already generic — no per-CLI case.)
- [ ] Added to `adapter.contract.test.ts` (an `AgentCliHarness` over your codec); codec-level tests for `parse` / argv dialects / `classify`; `npm run typecheck` and `npm test` are green.
- [ ] (optional, streaming — issue #23) A `streamExtractor` (the shared `sdkStreamExtractor` / `flatStreamExtractor`, or a custom one); `harnessArgs`/`readonlyArgs` branch on `stream` if the streaming output format is a different flag; final result is identical with/without streaming; streaming test added.
- [ ] (optional, only if read-only) Confirmed `readonlyArgs` is genuinely read-only — the LLM-provider role is then **automatic** via `codecFor` (no extra wiring); tested by constructing `AgentCliLlmProvider({ codec })` with a fake `exec` (returns parsed text, carries the read-only flag, fails closed).
```
