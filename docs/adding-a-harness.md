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
  run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult>;
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
the system changes when you add one.

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
| Headless / print invocation | `claude -p "<prompt>"` | `codex exec "<prompt>"` | how to run one non-interactive turn |
| Structured output | `--output-format json` | `--json` (JSONL stream) | a machine-readable result |
| Session resume | `--resume <id>` | `codex exec resume <id>` | continue the same conversation |

If a harness lacks structured output, parse its text output tolerantly and synthesize a session id.
If it lacks resume, return a stable session id and accept that each turn is cold (note it).

## The two mappings you must define

The shared core (`src/agent-cli/output.ts`) already owns the **envelope machinery** — the
whole-object / amid-noise / JSONL walk, latching the **first** session id seen, keeping the **last**
text-bearing line, accruing token counts, and never throwing. You supply two small, tool-specific
pieces.

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

## Skeleton (copy `src/harness/claude-code.ts` and adapt)

```ts
import { coerceSessionId, type SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';
import { parseAgentOutput, flatExtractor } from '../agent-cli/output';
import { classifyHarnessRun } from './classify';

// Injectable subprocess seam so tests never spawn a real process.
export type ExecFn = (
  args: string[],
  input: { prompt: string },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

const UNKNOWN = 'myagent-unknown';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Reuse the shared factory for a flat envelope, or write a custom FieldExtractor (see above).
export const myExtractor = flatExtractor();
export const parseMyAgentOutput = (stdout: string) => parseAgentOutput(stdout, myExtractor);

export class MyAgentAdapter implements HarnessAdapter {
  readonly name = 'myagent';
  readonly #exec: ExecFn;
  readonly #model: string | undefined;
  constructor(opts: { exec?: ExecFn; timeoutMs?: number; model?: string } = {}) {
    this.#exec = opts.exec ?? defaultExec(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#model = opts.model;
  }
  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = ['exec', '--output-format', 'json'];
    if (this.#model !== undefined) args.push('--model', this.#model); // model is wiring, not contract
    if (sessionId !== undefined) args.push('--session-id', sessionId); // flags first, prompt last
    args.push(prompt);

    let r: Awaited<ReturnType<ExecFn>>;
    try {
      r = await this.#exec(args, { prompt });
    } catch (err) {
      return HarnessRunResult.parse({
        output: err instanceof Error ? err.message : String(err),
        sessionId: coerceSessionId(sessionId, UNKNOWN),
        status: 'crashed',
      });
    }

    // Standard policy. If your CLI needs codex's inverted mapping, write a bespoke tail instead.
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
harness model in for you — see "Register it" below.

## Register it (two tiny edits)

```ts
// src/cli/args.ts — add the literal to the choice union + parser
export type HarnessChoice = 'claude-code' | 'codex' | 'droid' | 'fake' | 'myagent';
// ...allow it in parseHarness(...)

// src/cli/compose.ts — wire it in makeHarness(choice, model)
case 'myagent': return new MyAgentAdapter(model !== undefined ? { model } : {});
```

Optionally export it (and your `myExtractor`) from `src/index.ts` for embedders.

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
    extractor: myExtractor,                       // the SAME extractor your adapter uses
    buildArgs: (prompt) => myagentCompletionArgs(prompt, model),
  });
```

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
add adapter-specific tests for your `parse<Name>Output` (real-output samples → fields).

## Checklist

- [ ] A `FieldExtractor` (or the shared `flatExtractor`) + a `parse<Name>Output` wrapper over `parseAgentOutput`; the extractor never throws and emits `text` only for real results.
- [ ] `run()` never throws; uses `classifyHarnessRun` (or a documented bespoke tail) and returns a `HarnessRunResult.parse(...)`d value; session id uses `coerceSessionId(..., '<name>-unknown')`.
- [ ] Subprocess is injectable; tests pass with a fake exec and don't spawn anything.
- [ ] Added to `adapter.contract.test.ts`; `npm run typecheck` and `npm test` are green.
- [ ] Registered in `args.ts` + `compose.ts` (`makeHarness(choice, model)`); documented the assumed CLI contract in a comment.
- [ ] (optional) `--model` threaded into the argv via a `model?` constructor option.
- [ ] (optional, only if read-only) Exported the `FieldExtractor`; added a read-only `*CompletionArgs` builder + `makeLlmProvider()` case + `LlmProviderChoice` literal; tested it returns parsed text, carries the read-only flag, and fails closed.
```
