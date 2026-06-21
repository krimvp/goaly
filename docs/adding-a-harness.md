# Adding a harness

A "harness" is a coding agent you can drive headlessly (Claude Code, Codex, Aider, Cursor CLI,
your own). Adding one is deliberately **one file** implementing **one method**. This guide shows
exactly what to map and how. To probe an unfamiliar CLI first, use the
[`investigate-harness`](../.claude/skills/investigate-harness/SKILL.md) skill — it produces the
flag/field/status mapping this guide asks for.

## The contract

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

That's the whole seam. The orchestrator can't tell which harness it called, so nothing else in
the system changes when you add one. The optional `onEvent` (an `AgentEventSink`) is the **streaming
tap** — opt-in, observability-only, ignored entirely if you don't implement it; it's covered in
[The stream mapping](#3-stream-mapping--a-streameventextractor-optional-issue-23) below. Existing
callers and adapters that omit it keep compiling unchanged.

### What `run()` MUST do

1. **Spawn the agent headlessly** with `prompt`, resuming `sessionId` when provided.
2. **Parse stdout tolerantly** — partial output, crashes, and non-JSON are *normal*, not errors.
3. **Thread the session id** out (so the next iteration resumes the same conversation).
4. **Map the outcome to a `status`** and return a Zod-parsed `HarnessRunResult`.
5. **Never throw.** Any failure becomes `status: 'crashed' | 'truncated' | 'timeout'`. The reducer
   treats a non-`completed` run as a failed iteration and feeds it back — it must not crash the loop.

### What `run()` must NOT do

- **Don't compute `diffHash`.** The shared `Workspace` does that (so stuck-detection works on any
  harness for free). It's not even in `HarnessRunResult`.
- **Don't run the verifier.** Verification is "run this command in the workspace," identical
  everywhere — outside every adapter.
- **Don't leak harness specifics** (hook tricks, flag dialects) past `run()`. Claude Code's optional
  in-process `Stop`-hook fast-path, for example, would live *inside* its adapter behind the same
  `run()`.

## The three things to discover (the lowest common denominator)

Every serious harness exposes these; find each for your target:

| Capability | Claude Code | Codex | What you need |
|---|---|---|---|
| Headless / print invocation | `claude -p "<prompt>"` | `codex exec --full-auto "<prompt>"` | how to run one non-interactive turn |
| Structured output | `--output-format json` | `--json` (JSONL stream) | a machine-readable result |
| Session resume | `--resume <id>` | `codex exec resume <id>` | continue the same conversation |
| Streaming turns *(optional)* | `--output-format stream-json --verbose` | `--json` (already a JSONL stream) | per-turn events for live observability (issue #23) |

If a harness lacks structured output, parse its text output tolerantly and synthesize a session id.
If it lacks resume, return a stable session id and accept that each turn is cold (note it). If it has
no per-turn streaming mode, **skip the stream mapping** — `onEvent` stays unimplemented and the run
is unaffected (a tool that only emits a final envelope can still degrade to a couple of events).

**The harness role must be able to edit the tree.** A harness *drives* the agent, so its invocation
must run in a writable mode — the opposite of the read-only `LlmProvider` role below. Some CLIs are
read-only by default and need an explicit write flag: `codex exec` runs in a read-only sandbox unless
you pass `--full-auto` (its alias for a workspace-write sandbox), so the codex *harness* passes it
while the codex *provider* deliberately passes `--sandbox read-only`. If you forget it, the agent can
diagnose but never apply a fix and every iteration no-diffs.

## The mappings you must define

The shared core (`src/agent-cli/`) already owns the **envelope machinery** — for the FINAL result
(`output.ts`: the whole-object / amid-noise / JSONL walk, latching the **first** session id seen,
keeping the **last** text-bearing line, accruing token counts) and, for the live STREAM
(`stream.ts`: a `StreamTap` that buffers partial lines across stdout chunks, parses each completed
JSONL line, Zod-validates events at the seam, and forwards them to a sink) — and **never throws**.
You supply two small, tool-specific mappings (the third, streaming, is optional).

### 1. Field mapping — a `FieldExtractor`

A `FieldExtractor` is `(obj) => { text?, sessionId?, tokens?, isError? }`: pull those fields out of
**one** parsed JSON object by your CLI's key names. Your tolerant parser is then a one-liner.

```ts
import { parseAgentOutput, flatExtractor, type FieldExtractor } from '../agent-cli/output';

// If your envelope is FLAT (text under result/text/response, session under session_id/sessionId,
// tokens in a `usage` block) you don't write one at all — reuse the shared factory:
export const myExtractor = flatExtractor();                  // claude-code & droid use exactly this
// droid only adds a soft-error flag: flatExtractor({ errorKey: 'is_error' })

// Write a CUSTOM extractor only if your shapes are nested (see `codexExtractor` in codex.ts,
// which walks message/content[]/delta and thread-id session keys):
export const myExtractor: FieldExtractor = (obj) => ({ /* ...pull your fields... */ });

export const parseMyAgentOutput = (stdout: string) => parseAgentOutput(stdout, myExtractor);
```

An extractor must **never throw**, and should emit `text` only when the object actually carries a
result — the flat extractor treats `''` as present (text-bearing); codex requires non-empty (your
call what counts as "no text"). `parseAgentOutput` returns `null` when nothing usable parsed.

### 2. Status mapping — process outcome → `status`

For the standard policy, call the shared `classifyHarnessRun({ parsed, code, stderr, timedOut,
sessionId, unknownSession })` (from `src/harness/classify.ts`, used by claude-code **and** droid):

| Condition | status |
|---|---|
| timed out (killed for exceeding the wall-clock budget) | `timeout` (salvages any parsed text) |
| exited non-zero | `crashed` |
| exit 0, parseable, non-empty result | `completed` |
| exit 0 but empty / unparseable result | `truncated` |
| a soft `isError` flag on a clean exit | `truncated` |

If your CLI needs a **different** policy — codex, for instance, maps no-parse → `crashed` and
non-zero-with-text → `truncated` — keep a bespoke tail in `run()` instead. Either way, always
construct the result through `HarnessRunResult.parse(...)` so a bad mapping is caught at the
boundary, and resolve the session with `coerceSessionId(candidate, '<name>-unknown')` (from
`src/domain/ids.ts`) so an absent/hostile id falls back safely instead of throwing.

### 3. Stream mapping — a `StreamEventExtractor` *(optional, issue #23)*

The **streaming sibling of the field mapping**. Where the `FieldExtractor` converges your tool's
*final* output into one `AgentFields` abstraction, a `StreamEventExtractor` converges your tool's
*intermediate turns* into one **canonical, tool-neutral event taxonomy** — the same abstraction-first
discipline, so no tool-specific event shapes ever leak past the parser and every harness converges to
the same events. Implement it only if your CLI has a per-turn streaming mode; skip it otherwise (the
`onEvent` arg simply stays unused and the run is unaffected).

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
import { sdkStreamExtractor, flatStreamExtractor, type StreamEventExtractor } from '../agent-cli/stream';

// If your tool emits the ANTHROPIC AGENT-SDK stream-json envelope (system/assistant/user/result
// events) you don't write one at all — reuse the shared factory (claude-code & droid use exactly this):
export const myStreamExtractor = sdkStreamExtractor();                  // droid adds { errorKey: 'is_error' }

// If your tool only emits a single FINAL result object, degrade with the flat factory
// (session → message → usage → done):
export const myStreamExtractor = flatStreamExtractor({ errorKey: 'is_error' });

// Write a CUSTOM extractor only for a bespoke JSONL shape (see `codexStreamExtractor` in codex.ts,
// which maps thread.started → session, item.completed agent_message → message, command_execution →
// tool_use + tool_result, turn.completed → usage + done):
export const myStreamExtractor: StreamEventExtractor = (obj) => { /* ...map one line... */ return []; };
```

Then, in `run()`, build a `StreamTap(myStreamExtractor, onEvent)` only when `onEvent` is provided,
feed it each stdout chunk via the exec's optional `onStdout` callback, and `end()` it once the
process closes (flushes a final unterminated line). If your stream mode is a *different* flag from
your normal structured output (claude-code & droid switch `--output-format json` → `stream-json`
when streaming; codex's `--json` is already a stream), select it based on whether `onEvent` is set.
The **final-result parse is unchanged** — the `FieldExtractor` still recovers the same `output` from
the stream's closing line, so a non-streaming caller sees byte-identical behavior. See the skeleton
below and `src/harness/streaming.test.ts` for the test pattern (a fake exec replays canned JSONL
through `onStdout`; assert the ordered events, that the final result is identical with/without
streaming, and that a throwing sink never changes the result).

## Skeleton (copy `src/harness/claude-code.ts` and adapt)

```ts
import { coerceSessionId, type SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';
import { parseAgentOutput, flatExtractor } from '../agent-cli/output';
import { StreamTap, sdkStreamExtractor, type AgentEventSink } from '../agent-cli/stream';
import { classifyHarnessRun } from './classify';

// Injectable subprocess seam so tests never spawn a real process. The optional `onStdout` (issue
// #23) is the live tap: the default exec forwards each raw stdout chunk to it as it arrives.
export type ExecFn = (
  args: string[],
  input: { prompt: string },
  onStdout?: (chunk: string) => void,
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

const UNKNOWN = 'myagent-unknown';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Reuse the shared factories for the field + stream mappings, or write custom ones (see above).
export const myExtractor = flatExtractor();
export const myStreamExtractor = sdkStreamExtractor();
export const parseMyAgentOutput = (stdout: string) => parseAgentOutput(stdout, myExtractor);

export class MyAgentAdapter implements HarnessAdapter {
  readonly name = 'myagent';
  readonly #exec: ExecFn;
  readonly #model: string | undefined;
  constructor(opts: { exec?: ExecFn; timeoutMs?: number; model?: string } = {}) {
    this.#exec = opts.exec ?? defaultExec(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#model = opts.model;
  }
  async run(prompt: string, sessionId?: SessionId, onEvent?: AgentEventSink): Promise<HarnessRunResult> {
    // Build the tap only when asked; pick the streaming output format when streaming (issue #23).
    const tap = onEvent !== undefined ? new StreamTap(myStreamExtractor, onEvent) : undefined;
    const args = ['exec', '--output-format', tap !== undefined ? 'stream-json' : 'json'];
    if (this.#model !== undefined) args.push('--model', this.#model); // model is wiring, not contract
    if (sessionId !== undefined) args.push('--session-id', sessionId); // flags first, prompt last
    args.push(prompt);

    let r: Awaited<ReturnType<ExecFn>>;
    try {
      r = await this.#exec(args, { prompt }, tap ? (chunk) => tap.push(chunk) : undefined);
    } catch (err) {
      tap?.end();
      return HarnessRunResult.parse({
        output: err instanceof Error ? err.message : String(err),
        sessionId: coerceSessionId(sessionId, UNKNOWN),
        status: 'crashed',
      });
    }
    tap?.end(); // flush a final unterminated JSONL line before the result is assembled

    // Standard policy. If your CLI needs codex's inverted mapping, write a bespoke tail instead.
    // The final parse uses `myExtractor` over the SAME stdout, streaming or not — identical result.
    return classifyHarnessRun({
      parsed: parseMyAgentOutput(r.stdout),
      code: r.code,
      stderr: r.stderr,
      timedOut: r.timedOut,
      sessionId,
      unknownSession: UNKNOWN,
    });
  }
}
```

`defaultExec` should spawn the real binary, capture stdout/stderr, enforce the timeout, and resolve
(never reject) — mirror `defaultExec` in `claude-code.ts` (or reuse `runProcess` from
`src/util/spawn.ts`, which already caps output size and never rejects).

Supporting `--model` is optional but cheap: take a `model?` constructor option and push `--model
<model>` into the argv (before the prompt positional). The composition root passes the resolved
harness model in for you — see "Register it" below. The same goes for the wall-clock cap: keep the
`timeoutMs?` constructor option (it already exists in the skeleton) and `makeHarness` threads the
user's `--harness-timeout-ms` into it — you don't write any flag parsing for it.

## Register it (two tiny edits)

```ts
// src/cli/args.ts — add the literal to the choice union + parser
export type HarnessChoice = 'claude-code' | 'codex' | 'droid' | 'fake' | 'myagent';
// ...allow it in parseHarness(...)

// src/cli/compose.ts — wire it in makeHarness(choice, model, timeoutMs?)
// `opts` already carries { model?, timeoutMs? }, so just pass it through:
case 'myagent': return new MyAgentAdapter(opts);
```

Optionally export it (and your `myExtractor` / `myStreamExtractor`) from `src/index.ts` for embedders.

## Optional: also use the tool for the LLM steps (compiler / judge / approver)

A harness *drives* the agent. The three LLM workflow steps — authoring the verification (compiler),
the LLM-judge rung, and the Gate-B approver — are a **separate** seam, `LlmProvider`:

```ts
// src/llm/provider.ts
interface LlmProvider {
  readonly name: string;
  complete(req: { system?: string; prompt: string; temperature?: number }): Promise<string>;
}
```

It is deliberately **not** the same interface as `HarnessAdapter` (Interface Segregation): `run()`
is session-threaded and **may edit the working tree**; `complete()` is a stateless, **read-only**
`prompt → text`. A judge or approver that mutated the tree would corrupt the very diff it is judging.
So wiring your tool here is opt-in — and you get to **reuse the `FieldExtractor` you already wrote**.

`AgentCliLlmProvider` (`src/llm/agent-cli-provider.ts`) does the plumbing — build a read-only argv,
exec, parse with your extractor via the same shared `parseAgentOutput`, return the text or fail
closed. You supply three things:

1. **A read-only invocation — mandatory.** Find the flag that forbids edits: codex uses
   `--sandbox read-only`; droid's `exec` is read-only *unless* you pass `--auto`, so we omit it.
   **If your CLI has no read-only mode, do not wire it as a provider** — an agentic judge that can
   write the tree breaks the frozen-bar guarantee.
2. **Reuse your `FieldExtractor`** (export it from your adapter file).
3. **Three small registration edits:**

```ts
// src/cli/args.ts — add the literal to the provider union + parser
export type LlmProviderChoice = 'claude' | 'codex' | 'droid' | 'myagent';
// ...allow it in parseLlmProvider(...)

// src/cli/compose.ts — a read-only argv builder + a makeLlmProvider() case
export function myagentCompletionArgs(prompt: string, model: string | undefined): string[] {
  return ['exec', '--read-only', ...(model !== undefined ? ['--model', model] : []), prompt, '--json'];
}
case 'myagent':
  return new AgentCliLlmProvider({
    name: 'myagent',
    command: 'myagent',
    extractor: myExtractor,                       // the SAME field extractor your adapter uses
    buildArgs: (prompt) => myagentCompletionArgs(prompt, model),
    // Streaming (issue #23) — the LLM steps stream too, reusing your stream mapping. The sink is
    // wired here at CONSTRUCTION (not via complete()) so the Verifier/Approver seams stay clean;
    // makeLlmProvider() receives the phase-bound sink and forwards it as `onEvent`:
    ...(onEvent !== undefined ? { onEvent, streamExtractor: myStreamExtractor } : {}),
  });
```

The **stream mapping applies to the read-only `LlmProvider` too** — `AgentCliLlmProvider` reuses the
same `StreamTap`, so the compile / judge / approve turns surface in the live view exactly like the
agent run, just phase-tagged differently. You write the `StreamEventExtractor` once and both seams
use it. (The composition root passes `onEvent` into `makeLlmProvider()` for you; a custom provider
class wiring its own CLI would accept `onEvent` + `streamExtractor` in its constructor the same way.)

That's it. The resolved per-step model is threaded in for you, and the cascade
(`--judge-model`/`--approver-model`/`--compiler-model` → `--llm-model` → `--model` → tool default)
applies automatically — your provider just receives a `model` string or `undefined`.

**Caveats to document.** Each `complete()` is a full (read-only) agent turn, and the judge calls it
`quorum` times (default 3) per iteration — heavier than a one-shot completion API, which is why
`claude` stays the default. And model names are tool-specific: align `--llm-provider` with the model
you pass, or the cascade may hand a name from one tool's namespace to another (`claude --model
<a-codex-model>`).

**Test the provider** by injecting a fake `exec` into `AgentCliLlmProvider` (see
`src/llm/agent-cli-provider.test.ts`): assert it returns your parsed text, that the argv carries
your read-only flag (and `--model` when set), and that hostile/empty output **throws** (fail
closed). Unit-test your `*CompletionArgs` builder directly (see `src/cli/compose.test.ts`).

## Test it (no real process)

Inject a fake `exec` and assert the seam invariants. The shared contract test in
`src/harness/adapter.contract.test.ts` runs every adapter through the same matrix — add yours to
its `adapters` array so it's proven to **never throw**, always return a valid `HarnessRunResult`,
and map each scenario (success / non-zero / garbage / timeout / exec-throws) to a sane status. Then
add adapter-specific tests for your `parse<Name>Output` (real-output samples → fields). If you
implemented the stream mapping, also add a streaming test (fake exec replays canned JSONL through
`onStdout` → assert ordered `AgentStreamEvent`s, an identical final result with/without streaming,
and a throwing sink that never changes the result) — see `src/harness/streaming.test.ts`.

## Checklist

- [ ] A `FieldExtractor` (or the shared `flatExtractor`) + a `parse<Name>Output` wrapper over `parseAgentOutput`; the extractor never throws and emits `text` only for real results.
- [ ] `run()` never throws; uses `classifyHarnessRun` (or a documented bespoke tail) and returns a `HarnessRunResult.parse(...)`d value; session id uses `coerceSessionId(..., '<name>-unknown')`.
- [ ] Subprocess is injectable; tests pass with a fake exec and don't spawn anything.
- [ ] Added to `adapter.contract.test.ts`; `npm run typecheck` and `npm test` are green.
- [ ] Registered in `args.ts` + `compose.ts` (`makeHarness(choice, model, timeoutMs?)`); documented the assumed CLI contract in a comment.
- [ ] (optional) `--model` threaded into the argv via a `model?` constructor option; keep the `timeoutMs?` option so `--harness-timeout-ms` is honored.
- [ ] (optional, streaming — issue #23) A `StreamEventExtractor` (the shared `sdkStreamExtractor` / `flatStreamExtractor`, or a custom one) mapping per-turn JSONL onto `AgentStreamEvent`; `run()` builds a `StreamTap` only when `onEvent` is set, feeds it via `onStdout`, `end()`s it, and selects the streaming output format; final result is identical with/without streaming; streaming test added.
- [ ] (optional, only if read-only) Exported the `FieldExtractor` (and `StreamEventExtractor`); added a read-only `*CompletionArgs` builder + `makeLlmProvider()` case (pass `onEvent` + `streamExtractor`) + `LlmProviderChoice` literal; tested it returns parsed text, carries the read-only flag, and fails closed.
```
