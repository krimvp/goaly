# CLAUDE.md

See [`AGENTS.md`](AGENTS.md) for the canonical agent guide: build/test commands, the eight
invariants that must never be broken, code conventions, the directory map, and how to add a
harness. It applies to all agents working in this repo.

Quick reference:

- `npm run typecheck` and `npm test` must both be clean/green before any change is done.
- The reducer (`src/orchestrator/`) is pure and synchronous — never add IO/LLM/`Promise` there.
- The success contract is frozen after Gate A; DONE needs two keys (verifier + approver).
- Every external seam parses with Zod and fails closed.
- Adding a harness: read [`docs/adding-a-harness.md`](docs/adding-a-harness.md) and use the
  `investigate-harness` skill. A harness can optionally also back the LLM steps (read-only
  `LlmProvider` via `--llm-provider`).
- Meaningful changes to the architecture, the public API, or functionality must update `README.md`
  **and** the landing page ([`docs/index.html`](docs/index.html)) in the same change — it's a
  definition-of-done check, not optional. **Also update
  [`docs/adding-a-harness.md`](docs/adding-a-harness.md)** when you change the harness-authoring
  pattern (the `HarnessAdapter`/`LlmProvider` shape, the shared parsing core, or the registration
  edits). See `AGENTS.md` → "Keep the docs in sync".
