---
name: investigate-harness
description: >-
  Investigate an unfamiliar coding-agent CLI (Claude Code, Codex, Aider, Gemini CLI, Cursor CLI,
  a custom harness, etc.) to determine how to map it into a goaly HarnessAdapter. Discovers the
  headless/print invocation, the session-resume mechanism, the structured-output format, and any
  per-turn streaming mode; then derives the stdout field mapping (result text, session id, token
  usage), the optional stream mapping (intermediate turns onto the canonical AgentStreamEvent
  taxonomy), and the status mapping, and emits a filled-in adapter skeleton plus the registration
  edits. Use when adding a new harness to goaly, or when the user asks how a specific agent CLI
  behaves or what needs to be mapped to wrap it.
---

# Investigate a harness

Goal: produce everything needed to write `src/harness/<name>.ts` for a target coding-agent CLI —
the **flag mapping** (how to invoke headlessly + resume), the **field mapping** (where the result
text, session id, and token usage live in stdout), the optional **stream mapping** (how the
intermediate turns map onto goaly's canonical `AgentStreamEvent` taxonomy, issue #23), and the
**status mapping** — then output a filled adapter skeleton. You are filling in the contract described in
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
6. **Find the streaming mode (optional, issue #23).** Look for a per-turn streaming output format —
   `--output-format stream-json`, an always-JSONL `--json` (codex), `--stream`, SSE, etc. Capture a
   real sample and note, **per line `type`**, which lines carry: the session/thread id, an assistant
   message (full or a delta), reasoning/thinking, a tool/command **invocation** vs its **result**
   (with exit code), and per-turn token usage. Many tools emit the **Anthropic agent-SDK envelope**
   (`system`/`assistant`/`user`/`result` lines) — if so, reuse the shared `sdkStreamExtractor` and
   you're done. If the tool only emits a final envelope, note that (it degrades to a couple of
   events). If there's no streaming mode at all, record "none" and skip the stream mapping.
7. **Probe failure shapes.** Run with a bad flag / nonexistent session to see the non-zero exit and
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
Streaming mode:            none | stream-json | always-jsonl | other   # flag to request it, if any
Stream mapping (AgentStreamEvent):                                     # which line -> which event; (none) if no streaming
  session        <-  <line type / json path>   # e.g. type=system .session_id
  message        <-  <line type / json path>   # full or delta=true; e.g. type=assistant .message.content[].text
  reasoning      <-  <line type / json path>   # thinking, where exposed | (none)
  tool_use       <-  <line type / json path>   # invocation: name + input; e.g. command_execution (started)
  tool_result    <-  <line type / json path>   # output + exitCode; e.g. command_execution (completed) .exit_code
  usage          <-  <line type / json path>   # e.g. type=result .usage  | turn.completed .usage
  done           <-  <line type>               # e.g. type=result | turn.completed
  reuse?         <- sdkStreamExtractor() (Anthropic SDK envelope) | flatStreamExtractor() (final-only) | custom
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
3. **`<name>StreamExtractor` (optional, only if the tool streams)** — a `StreamEventExtractor`
   (`(obj) => AgentStreamEvent[]`) mapping one JSONL line onto the canonical taxonomy. Prefer reusing
   `sdkStreamExtractor()` (Anthropic SDK envelope) or `flatStreamExtractor()` (final-only); write a
   custom one only for a bespoke shape (base it on `codexStreamExtractor`). Record "(none)" if the
   tool has no streaming mode.
4. **The adapter class** `src/harness/<name>.ts` implementing `HarnessAdapter`, following the
   skeleton in `docs/adding-a-harness.md`: injectable `exec` (with the optional `onStdout` tap),
   never throws, every path returns `HarnessRunResult.parse(...)`, session id via
   `coerceSessionId(candidate, '<name>-unknown')`. If it streams, build a `StreamTap` only when
   `onEvent` is set, feed it via `onStdout`, `end()` it, and select the streaming output format.
5. **Registration edits**: add the literal to `HarnessChoice` + `parseHarness` in `src/cli/args.ts`
   and a `case` in `makeHarness` in `src/cli/compose.ts`.
6. **Tests**: add the adapter to the `adapters` array in `src/harness/adapter.contract.test.ts`, and
   write `src/harness/<name>.test.ts` with the captured real-output sample(s) -> expected fields and
   the status-mapping cases (success / non-zero / garbage / timeout / exec-throws), using an
   injected fake `exec`. If it streams, add a streaming test (canned JSONL via `onStdout` → ordered
   `AgentStreamEvent`s; identical final result with/without streaming; a throwing sink that never
   changes the result) — see `src/harness/streaming.test.ts`.

Finish by running `npm run typecheck` and `npx vitest run src/harness/<name>.test.ts
src/harness/adapter.contract.test.ts` and reporting green. Do **not** weaken any invariant in
[`AGENTS.md`](../../../AGENTS.md) — especially: the adapter must never throw, and it must not compute
`diffHash` or run the verifier (those live in the shared `Workspace`).
