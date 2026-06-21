---
name: investigate-harness
description: >-
  Investigate an unfamiliar coding-agent CLI (Claude Code, Codex, Aider, Gemini CLI, Cursor CLI,
  a custom harness, etc.) to determine how to map it into a goalorch HarnessAdapter. Discovers the
  headless/print invocation, the session-resume mechanism, and the structured-output format; then
  derives the stdout field mapping (result text, session id, token usage) and the status mapping,
  and emits a filled-in adapter skeleton plus the two registration edits. Use when adding a new
  harness to goalorch, or when the user asks how a specific agent CLI behaves or what needs to be
  mapped to wrap it.
---

# Investigate a harness

Goal: produce everything needed to write `src/harness/<name>.ts` for a target coding-agent CLI —
the **flag mapping** (how to invoke headlessly + resume), the **field mapping** (where the result
text, session id, and token usage live in stdout), and the **status mapping** — then output a
filled adapter skeleton. You are filling in the contract described in
[`docs/adding-a-harness.md`](../../../docs/adding-a-harness.md); read it and
`src/harness/claude-code.ts` + `src/harness/codex.ts` first as the canonical templates.

## Guardrails

- **Probe read-only first.** `--help`, `--version`, and subcommand help reveal most flags without
  running the agent.
- **Run the agent only in a throwaway git repo** (`mktemp -d`, `git init`, one commit) with a
  trivial prompt like `"print the word ready and make no file changes"`. Never investigate against
  the user's real workspace.
- **Never echo secrets.** If auth is required, assume the user has configured it; do not print API
  keys or tokens. **Redact** session ids in any report (`abc…123`).
- Time-box live invocations; if the CLI hangs waiting for interactive input, you found that it has
  no headless mode — record that and stop.

## Procedure

Work through these and record findings in the worksheet below.

1. **Identify the binary.** Confirm it's installed and get the version:
   `which <bin>; <bin> --version`. Note the version — flags drift between versions.
2. **Find the headless / print invocation.** Look in `<bin> --help` and `<bin> <subcmd> --help`
   for a non-interactive/print/exec/headless flag (e.g. `-p`, `exec`, `--print`, `--headless`,
   `--message`). The prompt is usually an argv value or read from stdin.
3. **Find structured output.** Look for `--output-format json`, `--json`, `--format=json`, or
   similar. Capture a **real sample** of stdout from a trivial run. Note the shape:
   - whole-stdout JSON object, **or** JSONL stream (one event per line), **or** plain text only.
4. **Find session resume.** Look for `--resume <id>`, `--continue`, `resume <id>`, `--session <id>`,
   `--thread <id>`. Determine: where does the session/thread id appear in the *output* of a fresh
   run, and which flag *replays* it on the next run?
5. **Find token usage.** In the sample output, look for `usage`, `total_tokens`, `input_tokens` +
   `output_tokens`, or a cost field. Optional — fine if absent.
6. **Probe failure shapes.** Run with a bad flag / nonexistent session to see the non-zero exit and
   stderr. Confirm whether malformed runs still emit partial JSON (→ `truncated`) or nothing (→
   `crashed`).

## Discovery worksheet (fill this in)

```
Harness name (kebab):      <name>
Binary + version:          <bin> <version>
Fresh invocation:          <bin> <args...>           # e.g. claude -p "<prompt>" --output-format json
Resume invocation:         <bin> <args...> <id>      # e.g. claude -p "<prompt>" --resume <id> --output-format json
Prompt delivery:           argv | stdin
Output shape:              json-object | jsonl-stream | text-only
Field mapping:
  result text    <-  <json path>    # e.g. .result  |  last line's .text
  session id     <-  <json path>    # e.g. .session_id (latch FIRST seen in a stream)
  token usage    <-  <json path>    # e.g. .usage.total_tokens  | (none)
Status mapping:
  timeout    <= wall-clock kill
  crashed    <= exit != 0  | unparseable stdout | exec throws
  truncated  <= exit 0 but empty/partial result
  completed  <= exit 0 + parseable non-empty result
Notes / caveats:           <e.g. no resume support -> cold each turn; flags differ in v2>
```

## Deliverable

Produce, in order:

1. **The filled worksheet** above (session ids redacted).
2. **`parse<Name>Output(stdout)`** — a pure, tolerant function returning
   `{ text; sessionId?; tokens? } | null`, latching the **first** session id across a stream and
   returning `null` when no usable text is found. Base it on `parseClaudeOutput` /
   `parseCodexOutput`.
3. **The adapter class** `src/harness/<name>.ts` implementing `HarnessAdapter`, following the
   skeleton in `docs/adding-a-harness.md`: injectable `exec`, never throws, every path returns
   `HarnessRunResult.parse(...)`, session id via `coerceSessionId(candidate, '<name>-unknown')`.
4. **Registration edits**: add the literal to `HarnessChoice` + `parseHarness` in `src/cli/args.ts`
   and a `case` in `makeHarness` in `src/cli/compose.ts`.
5. **Tests**: add the adapter to the `adapters` array in `src/harness/adapter.contract.test.ts`, and
   write `src/harness/<name>.test.ts` with the captured real-output sample(s) -> expected fields and
   the status-mapping cases (success / non-zero / garbage / timeout / exec-throws), using an
   injected fake `exec`.

Finish by running `npm run typecheck` and `npx vitest run src/harness/<name>.test.ts
src/harness/adapter.contract.test.ts` and reporting green. Do **not** weaken any invariant in
[`AGENTS.md`](../../../AGENTS.md) — especially: the adapter must never throw, and it must not compute
`diffHash` or run the verifier (those live in the shared `Workspace`).
