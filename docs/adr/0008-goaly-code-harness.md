# ADR 0008 — `goaly-code`: an SDK-native (non-codec) harness over OpenAI-compatible endpoints

## Status
Accepted.

## Context
Every harness so far is an `AgentCliCodec` (ADR-implicit since the harness refactor): goaly wraps a
hardened external CLI (`claude` / `codex` / `droid` / `pi`) that fills the entire agent loop for free
— tool-use, file editing, context management, session/resume, streaming, token accounting — so a
codec is ~150 lines. That delegation is the codec's strength, but it also means goaly does **not** own
the inference path: it cannot fine-tune the loop, cannot run against an arbitrary OpenAI-compatible
endpoint with no CLI installed, and cannot emit the loop's own labeled trajectories.

Two facts make owning the loop worth its cost (see `WORKSPEC-sdk-harness.md`):
1. goaly is an unusually good RL/eval environment — the frozen verifier ladder is a literal pass/fail
   oracle and the approver is an independent key, so every run is an automatically-labeled trajectory.
2. The success criterion is frozen and the approver is independent (invariants #2/#3), so a policy
   trained on goaly runs **cannot reward-hack** by weakening the contract — reward-hacking-resistant
   by construction.

And a safety asymmetry de-risks shipping a rough harness: a weak harness **cannot produce a wrong
green** — the frozen ladder + veto-only approver catch bad work; a weak agent just burns FAIL
iterations or trips a STUCK detector. So an imperfect non-codec harness is safe to ship and improve
under a real signal.

## Decision
Ship **`--harness goaly-code`**, the first **non-codec** `HarnessAdapter` (seam #1): goaly becomes the
coding agent itself, driving an OpenAI-compatible chat-completions endpoint through its **own**
tool-use loop. It is purely additive — `claude`/`codex`/`droid`/`pi` are byte-for-byte unchanged, and
`codecFor` is untouched (goaly-code is not a codec).

New leaves, the pure reducer never touched (invariant #1):
- `src/llm-client/` — a shared HTTP transport (`OpenAiClient implements LlmClient`): `fetch` + Zod,
  base-url + bearer auth, bounded retries (network/429/5xx → fail-closed throw), per-request
  `AbortController` timeout, `usage` → `TokenBreakdown`. Injectable `fetch`/`sleep` for tests.
- `src/llm/openai-provider.ts` — a read-only `OpenAiLlmProvider` on the same client
  (`--llm-provider openai`): one `[system?, user]` exchange, no tools — structurally read-only, fails
  closed on empty text. The same transport backs both the harness and the LLM steps.
- `src/goaly-code/` — `harness.ts` (the adapter), `loop.ts` (the agent loop), `tools.ts` (the minimal
  Zod-validated tool set + the never-crash `dispatchTool`), `edit.ts` (reliability-first `edit_file`),
  `fs-host.ts` (path-guarded fs + the injected sandboxed `run_shell`), `session-store.ts` (resumable
  persistence), `prompt.ts` (the goaly-tuned system prompt).

The flag value, the adapter's runtime `name`, and the minted session-id prefix are all `goaly-code`
(parallels `claude-code`). The OpenAI transport keeps its accurate name — it is the genuinely
OpenAI-compatible layer, shared with `--llm-provider openai`.

### Honoring the invariants
- **#1 zero-LLM reducer** — the harness is a seam-#1 leaf; the reducer is untouched.
- **#4 fail-closed / never-throw** — the loop maps every failure to a typed status: turn cap →
  `truncated`, wall-clock → `timeout`, client error after retries → `crashed` (feeds the pure
  `STUCK_HARNESS_CRASH` detector), a throwing/invalid tool call → an error string fed back to the
  model. `run()` never rejects. A dedicated adversarial test mirrors `adapter.contract.test.ts`.
- **#6 parse at every seam** — the chat-completions response is Zod-validated; every tool's arguments
  are Zod-validated; the persisted session log is re-parsed on read.
- **#7 write-ahead + resume** — the session store persists the message history before `run()` returns
  and reloads it (fail-closed) to resume.

### Sandbox at the tool grain (the key architectural difference)
A CLI harness is **one** opaque subprocess; the sandbox wraps the whole binary. goaly-code is goaly's
own process making the API call, plus **many** shell subprocesses (one per `run_shell`). Consequences:
the inference HTTP call is made by goaly itself (un-jailed); **file edits go through goaly's own
path-guarded writers, not a subprocess**; only `run_shell` is jailed, with the **same**
`SandboxLauncher` the codec harnesses use, at a *finer* grain. The composition root injects the
sandbox-wrapped shell into the host (harness network profile, but a **credential-scrubbed** env —
`run_shell` does not make the inference call, so unlike a CLI harness it never needs API keys; this is
strictly safer than the codec seam and matches the verifier default). The path guard resolves symlinks
on the deepest existing ancestor and re-checks containment, so a symlinked component cannot lead a
read/write/edit outside the workspace. Everything else in `src/goaly-code/` is testable with a fake shell.

### Edit reliability is the make-or-break of *quality* (not safety)
`edit_file` is where naive agents thrash. `edit.ts` is a pure function with a deliberate ladder —
exact match first, then whitespace-tolerant line matching — and returns a clear, actionable error for
every failure (not found / not unique / empty / no-op) so the model can recover. `write_file` is the
escape hatch. It carries the heaviest unit-test table in the slice.

## Consequences
- **Positive:** goaly owns the inference path — the substrate for a goaly-tuned trained model (the
  research arc, Slices 2–5: trajectory export, eval bench, rejection-sampling SFT, expert
  iteration/RL, productionized versioned model). Runs against any OpenAI-compatible endpoint (cloud or
  a local keyless ollama) with no CLI installed — only Node ≥ 20's `fetch`. Token usage maps cleanly
  from the API `usage` block (cleaner than CLIs, which often report nothing). Finer-grained isolation
  than wrapping an opaque CLI.
- **Negative / accepted:** on a frontier model goaly-code underperforms the tuned CLIs on hard tasks
  (weaker `edit_file`, no context compaction, naive recovery) — acceptable, since its job is to
  bootstrap data, and the two keys mean a weak harness costs *iterations*, never a wrong green. The
  `HarnessChoice`/`LlmProviderChoice` unions gain their first non-CLI members (`goaly-code`/`openai`),
  which `independence.ts` family-matching and the help/usage text now account for.
- **Scope guards (this slice):** no context summarization/compaction (the turn cap is the bound), no
  multi-file atomic edits, no speculative parallel tool calls, no provider-specific prompt-caching.

## Alternatives considered
- **Keep delegating to CLIs only.** Rejected: it forever blocks owning the inference path and the
  training arc, and excludes endpoints with no bundled CLI.
- **A new top-level seam for SDK harnesses.** Rejected: `HarnessAdapter` already abstracts "drive the
  agent"; `NoopHarness` already proves a non-codec adapter is legal. A second seam would leak the
  implementation distinction the orchestrator must not see.
- **Reuse a vendor SDK package.** Rejected for the transport: a thin `fetch` + Zod client is smaller,
  dependency-free (goaly ships only `zod`), and trivially fakeable in tests.
