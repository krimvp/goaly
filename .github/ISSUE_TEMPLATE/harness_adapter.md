---
name: 🔌 New harness adapter
about: Request or track support for a new coding-agent harness
title: "feat: add harness adapter — <name>"
labels: [feature, harness]
---

<!--
A new harness is normally ONE file implementing HarnessAdapter.run(). Use the `investigate-harness`
skill to probe the target CLI/API and produce the field/flag/status mapping before writing code.
See docs/adding-a-harness.md.
-->

## Harness

- Name (kebab):
- CLI / API + where to get it:
- Local CLI or cloud/API-backed? <!-- subprocess adapter vs. HTTP/SDK-backed (e.g. Devin) -->

## Why add it

<!-- Demand / fit. Anything notable about this harness vs. the ones already supported. -->

## Discovery (fill via the `investigate-harness` skill)

<!-- Redact session ids. -->

- Headless / print invocation:
- Session-resume mechanism:
- Structured-output shape: <!-- json-object | jsonl-stream | text-only -->
- Field mapping: result text ← … · session id ← … · token usage ← … (optional)
- Status mapping: timeout / crashed / truncated / completed

## Implementation checklist

- [ ] `src/harness/<name>.ts` implementing `HarnessAdapter`, reusing `parseAgentOutput` +
      a `FieldExtractor` (`flatExtractor` for a flat envelope) and `classifyHarnessRun`
- [ ] Parse at the seam (Zod), **fail-closed** — adapter never throws (invariant #4)
- [ ] Injectable `exec`/client so tests don't spawn processes or hit the network
- [ ] Registered: `HarnessChoice` + `parseHarness` in `src/cli/args.ts`, `case` in `src/cli/compose.ts`
- [ ] Tests: added to `src/harness/adapter.contract.test.ts` + `src/harness/<name>.test.ts` with real
      captured output → expected fields and the status-mapping cases
- [ ] Docs synced: README support section, docs/index.html support matrix + harness tabs,
      docs/adding-a-harness.md
- [ ] (Optional) read-only `LlmProvider` via `AgentCliLlmProvider` + `--llm-provider`, if the tool
      has a read-only/print mode

## Notes / open questions
