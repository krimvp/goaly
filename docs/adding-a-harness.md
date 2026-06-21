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

### 1. Field mapping — stdout → `{ text, sessionId, tokens }`

Write a pure, exported `parse<Name>Output(stdout): { text; sessionId?; tokens? } | null` that:

- finds the **result text** (the agent's final message),
- finds the **session/thread id** — latch the **first** one seen across a JSONL stream (it's
  established once at stream start; a later per-message `id` must not clobber it),
- finds **token usage** if present,
- returns `null` when nothing usable parsed (so the adapter maps that to `crashed`).

Make it tolerant: handle a whole-stdout JSON object, JSON surrounded by log noise, and JSONL where
the last line carries the answer.

### 2. Status mapping — process outcome → `status`

| Condition | status |
|---|---|
| timed out (you killed it for exceeding the wall-clock budget) | `timeout` |
| exited non-zero | `crashed` |
| exited 0, parseable, non-empty result | `completed` |
| exited 0 but empty / unparseable result | `truncated` |
| the exec seam itself threw | `crashed` (fail-closed) |

Always construct the result through `HarnessRunResult.parse(...)` so a bad mapping is caught at the
boundary, and use `coerceSessionId(candidate, '<name>-unknown')` (from `src/domain/ids.ts`) so an
absent/hostile session id falls back safely instead of throwing.

## Skeleton (copy `src/harness/claude-code.ts` and adapt)

```ts
import { coerceSessionId, SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';

// Injectable subprocess seam so tests never spawn a real process.
export type ExecFn = (
  args: string[],
  input: { prompt: string },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

const UNKNOWN = 'myagent-unknown';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function parseMyAgentOutput(stdout: string): { text: string; sessionId?: string; tokens?: number } | null {
  // ...tolerant parse; latch the FIRST session id; return null when no usable text...
}

export class MyAgentAdapter implements HarnessAdapter {
  readonly name = 'myagent';
  readonly #exec: ExecFn;
  constructor(opts: { exec?: ExecFn; timeoutMs?: number } = {}) {
    this.#exec = opts.exec ?? defaultExec(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }
  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = sessionId !== undefined
      ? ['exec', 'resume', sessionId, prompt, '--json']   // resume invocation
      : ['exec', prompt, '--json'];                        // fresh invocation
    let r: Awaited<ReturnType<ExecFn>>;
    try { r = await this.#exec(args, { prompt }); }
    catch { return HarnessRunResult.parse({ output: '', sessionId: coerceSessionId(sessionId, UNKNOWN), status: 'crashed' }); }

    if (r.timedOut) return HarnessRunResult.parse({ output: r.stderr, sessionId: coerceSessionId(sessionId, UNKNOWN), status: 'timeout' });

    const parsed = parseMyAgentOutput(r.stdout);
    if (parsed === null) return HarnessRunResult.parse({ output: r.stderr, sessionId: coerceSessionId(sessionId, UNKNOWN), status: 'crashed' });

    const status = r.code === 0 ? 'completed' : 'truncated';
    return HarnessRunResult.parse({
      output: parsed.text,
      sessionId: coerceSessionId(parsed.sessionId ?? sessionId, UNKNOWN),
      status,
      ...(parsed.tokens !== undefined ? { tokensUsed: parsed.tokens } : {}),
    });
  }
}
```

`defaultExec` should spawn the real binary, capture stdout/stderr, enforce the timeout, and resolve
(never reject) — mirror `defaultExec` in `claude-code.ts` (or reuse `runProcess` from
`src/util/spawn.ts`, which already caps output size and never rejects).

## Register it (two tiny edits)

```ts
// src/cli/args.ts — add the literal to the choice union + parser
export type HarnessChoice = 'claude-code' | 'codex' | 'fake' | 'myagent';
// ...allow it in parseHarness(...)

// src/cli/compose.ts — wire it in makeHarness()
case 'myagent': return new MyAgentAdapter();
```

Optionally export it from `src/index.ts` for embedders.

## Test it (no real process)

Inject a fake `exec` and assert the seam invariants. The shared contract test in
`src/harness/adapter.contract.test.ts` runs every adapter through the same matrix — add yours to
its `adapters` array so it's proven to **never throw**, always return a valid `HarnessRunResult`,
and map each scenario (success / non-zero / garbage / timeout / exec-throws) to a sane status. Then
add adapter-specific tests for your `parse<Name>Output` (real-output samples → fields).

## Checklist

- [ ] `parse<Name>Output` is pure, exported, tolerant, latches the first session id, returns `null` on no text.
- [ ] `run()` never throws; every path returns a `HarnessRunResult.parse(...)`d value.
- [ ] Status mapping matches the table above; session id uses `coerceSessionId(..., '<name>-unknown')`.
- [ ] Subprocess is injectable; tests pass with a fake exec and don't spawn anything.
- [ ] Added to `adapter.contract.test.ts`; `npm run typecheck` and `npm test` are green.
- [ ] Registered in `args.ts` + `compose.ts`; documented the assumed CLI contract in a comment.
```
