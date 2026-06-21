---
name: 🐞 Bug report
about: Report a reproducible defect in goaly
title: "bug: <short summary>"
labels: bug
---

<!--
A bug report is only useful if it can be reproduced. Before filing, try to replicate it yourself
on a minimal example. The maintainers (and the `work-on-issue` flow) will reproduce it again before
fixing — give them everything they need. Redact API keys and session ids.
-->

## Summary

<!-- One or two sentences: what goes wrong. -->

## Environment

- goaly version: <!-- `goaly --version` or the npm version -->
- Node version: <!-- `node --version` (≥ 20 required) -->
- OS / platform:
- Harness: <!-- claude-code | codex | droid | fake | ... -->
- LLM provider / models: <!-- --llm-provider, --model, --llm-model, --judge-model, ... if relevant -->

## Exact command / invocation

```bash
# The full `goaly run ...` (or embedding call) that triggers the bug.
```

## Steps to reproduce

<!-- Numbered, minimal, deterministic. Prefer the `fake` harness + `--verify-cmd "true"`/"false"
     when the bug is in the orchestration layer, so it reproduces without network/API access. -->

1.
2.
3.

## Expected behavior

## Actual behavior

<!-- Include the relevant output, the exit code (0 DONE / 1 FAILED|ABORTED / 2 usage), and any
     stack trace. If useful, attach the run log under `.goaly/<runId>/` with secrets/ids redacted. -->

## Reproducibility

<!-- always | intermittent (~N out of M runs). If intermittent, note any pattern. -->

## Preliminary cause (optional but valued)

<!-- Your best guess at *why* it happens: a suspected seam (harness / verifier ladder / approver /
     clock+budget), a file (e.g. src/orchestrator/decide.ts), or a parsing/fail-closed path. -->

## Invariant in question (if any)

<!-- Does this look like one of the eight invariants is violated? e.g. a non-green slipping through
     the verifier ladder, the contract changing after Gate A, DONE on a single key, an adapter
     throwing instead of failing closed, an unparsed seam. See AGENTS.md. -->

## Additional context
