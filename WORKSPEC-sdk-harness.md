# Work spec — SDK-native coding harness + a goaly-tuned trained model

> **Status:** spec / proposal. Execution to be staged (slices below); the training arc is a
> research bet gated on the harness landing first.
> **Decision (to make):** ship a **non-CLI `HarnessAdapter`** — the first one — that drives an
> OpenAI-compatible chat-completions endpoint through goaly's *own* agent loop, so we control the
> inference path. The end goal is not "reimplement claude-code"; it is to **own the substrate so we
> can fine-tune a small model that is specialized to the goaly loop**, using the frozen verifier
> ladder + approver as a free, reward-hacking-resistant training signal.
> **Default stays untouched:** `--harness claude` (and codex/droid/pi) are byte-for-byte unchanged;
> the SDK harness is purely additive, behind `--harness sdk`.

---

## 0. Why (context, already established)

A codec harness (claude/codex/droid/pi) is ~150 lines because it **delegates the entire agent loop
to a hardened binary**. `HarnessAdapter.run(prompt, sessionId?, onEvent?) → HarnessRunResult` is a
small contract, but a CLI fills it for free: tool-use loop, file editing, context management,
session/resume, streaming, token accounting. An SDK harness means **goaly becomes the coding
agent** and owns all of that.

Two facts make this worth doing despite that cost:

1. **goaly is an unusually good RL/eval environment.** The deterministic verifier ladder is a literal
   pass/fail oracle and the judge/approver are graded keys (two keys for DONE, invariant #3). Every
   run is an automatically-labeled trajectory — the expensive part of coding-agent training is free
   here.
2. **The success criterion is frozen and the approver is an independent key** (invariants #2/#3), so a
   policy being trained **cannot hack the reward** by weakening the contract. The environment is
   reward-hacking-resistant *by construction* — a rare and valuable property for RL.

And the safety asymmetry that de-risks shipping a rough harness: a weak harness **cannot produce a
wrong green**. The frozen ladder + veto-only approver catch bad work; a weak agent just burns more
FAIL iterations or trips a STUCK detector. So we can ship an imperfect harness without risking
correctness, and improve it under a real signal.

**Already in place (build on, do not rebuild):**
- `HarnessAdapter` is a one-method interface; `NoopHarness` already proves a **non-codec** adapter is
  legal (`src/cli/compose.ts`). The codec/registry machinery is **not** load-bearing for a new
  adapter.
- Workspace already has **path-guarded** writers/readers: `GitWorkspace.fileHash`,
  `writeWorkspaceFile` (traversal guards) — the SDK harness's file tools reuse these instead of raw fs.
- The **sandbox seam** (issue #9) wraps untrusted execs via a `SandboxLauncher.wrap()` +
  `withSandboxAgent` (`src/sandbox/`, `src/cli/compose.ts:sandboxedHarnessExec`). For an SDK harness
  the untrusted exec is each `run_shell` tool call, so the same launcher applies at a *finer* grain.
- **Streaming taxonomy** `AgentStreamEvent` (issue #23) + `StreamTap` already exist; the loop emits
  onto it.
- **Token metering** + `TokenBreakdown` (issues #17/#24) already exist; an API `usage` block maps
  onto them cleanly (cleaner than CLIs, which often report nothing).
- The proposed read-only **OpenAI `LlmProvider`** (separate, smaller piece) shares the same HTTP
  client — build it first as the transport layer, the harness reuses it.

**Missing (this spec):** a tool-use agent loop, a small reliable file-edit tool, a session store for
resume, the `--harness sdk` wiring, and the training/data pipeline.

---

## 1. Deliverables

Staged. Each slice is independently shippable and leaves `typecheck`/`test`/coverage green.

- **Slice 0 — transport (prereq):** OpenAI-compatible `LlmClient` (`fetch` + Zod, base-url + auth +
  `usage` parse, injectable, fail-closed) and the **read-only `OpenAiLlmProvider`** on top of it
  (judge/approver/compiler against any endpoint, no coding CLI installed). High standalone value;
  it is the harness's transport.
- **Slice 1 — minimal SDK harness (bootstrap quality):** `SdkHarness implements HarnessAdapter`
  behind `--harness sdk`: the agent loop, the minimal tool set, session persistence/resume, sandbox
  routing of `run_shell`, streaming + token accounting, all fail-closed. Good enough to **run goals
  and emit labeled trajectories** — explicitly *not* required to beat claude-code yet.
- **Slice 2 — eval bench + trajectory dataset:** a fixed, deterministic goaly-task benchmark + a
  trajectory exporter that labels every run with its ladder/approver outcome. The two assets the
  training arc consumes.
- **Slice 3 — rejection-sampling SFT:** filter passing trajectories → fine-tune a small open-weight
  model in *our* tool schema → beat the thin baseline on the bench.
- **Slice 4 — iterated improvement (expert iteration / RL):** the goaly loop as the training env;
  generate → filter by ladder → retrain → repeat, gated on no-regression against the bench.
- **Slice 5 — productionize the model** as a first-class, versioned harness target with continuous
  retraining from real runs.

Each slice updates the docs it touches (definition-of-done gate, §7): `README.md`,
`docs/index.html`, `docs/adding-a-harness.md` (the **first non-codec adapter** — the guide must grow
an "SDK harness" path), `AGENTS.md` directory map, and an ADR.

---

## 2. Architecture — the harness (Slice 1)

New leaves; the **pure reducer is never touched** (invariant #1). The harness lives entirely behind
seam #1.

### 2.1 Module layout
```
src/llm-client/
  openai-client.ts        # shared transport: fetch + Zod, base-url, auth, retries, usage→TokenBreakdown
  schema.ts               # Zod for the chat-completions request/response envelope (invariant #6)
src/sdk-harness/
  harness.ts              # SdkHarness implements HarnessAdapter (seam #1)
  loop.ts                 # the tool-use agent loop (turn cap, timeouts, fail-closed, event emit)
  tools.ts                # tool registry: read/list/grep/write/edit/shell/finish — Zod args each
  session-store.ts        # persist + resume message history keyed by SessionId (invariant #7)
  prompt.ts               # the goaly-tuned system prompt
src/llm/
  openai-provider.ts      # read-only OpenAiLlmProvider (Slice 0), reuses openai-client.ts
```

### 2.2 `SdkHarness.run(prompt, sessionId?, onEvent?)`
1. **Resolve session.** `sessionId` present → load prior message history from the `SessionStore`;
   absent → mint a new `SessionId`, start `[system, user(prompt)]`. A corrupt/missing session file
   degrades to a fresh session (logged loudly), **never throws** (invariant #4/#7).
2. **Run the loop** (`loop.ts`): repeatedly call the model; if the assistant returns `tool_calls`,
   dispatch each through the tool registry, append tool results, continue; if it returns a final
   message or calls `finish`, stop.
3. **Persist** the updated history under `sessionId` (write-ahead before returning — invariant #7).
4. **Return** `HarnessRunResult { output, sessionId, status, tokensUsed, tokenSource:'reported',
   tokenBreakdown }`. `status` ∈ `completed | crashed | truncated | timeout` — never reject.

### 2.3 The loop — termination & fail-closed (the contract that matters)
- **Turn cap:** max tool-use turns per `run()` → on hit, `status:'truncated'`.
- **Wall-clock + idle timeout:** reuse the `--harness-timeout-ms` / `--harness-idle-timeout-ms`
  semantics → `status:'timeout'`.
- **API error after bounded retries** (network, 5xx, malformed envelope that fails Zod) →
  `status:'crashed'`. Consecutive crashes already feed the pure `STUCK_HARNESS_CRASH` detector
  (invariant #8) — nothing new needed downstream.
- **A throwing tool** never propagates: the error becomes the *tool result string* fed back to the
  model (so it can recover), and never crashes the loop.
- The loop **never throws** out of `run()`. This is the single most important property; it gets a
  dedicated adversarial test pass (hostile/truncated/empty API responses → typed status, never a
  reject), mirroring `adapter.contract.test.ts`.

### 2.4 Tools (minimal viable set, all Zod-validated args — invariant #6)
| tool | notes |
|---|---|
| `read_file(path, range?)` | via `GitWorkspace.fileHash`/read path; traversal-guarded |
| `list_dir(path)` | workspace-relative |
| `grep(pattern, path?)` | reuse existing search; bounded output |
| `write_file(path, content)` | via `writeWorkspaceFile` (path-guarded) |
| `edit_file(path, old_string, new_string)` | **reliability-critical** — see §2.6 |
| `run_shell(command)` | **untrusted** — routed through the sandbox launcher; the *only* exec seam |
| `finish(summary)` | explicit termination, fills `output` |

### 2.5 Sandbox integration (the key architectural difference — call it out)
A CLI harness is **one** opaque subprocess; the sandbox wraps the whole binary. An SDK harness is
**goaly's own process** making the API call, plus **many** shell subprocesses (one per `run_shell`).
Consequence and upside:
- The API HTTP call is made by goaly itself (un-jailed) → no change to how the inference endpoint is
  reached; under an egress allowlist the inference host need not be in the jail's allowlist because
  the jailed surface is only `run_shell`.
- **File edits go through goaly's own path-guarded writers, not a subprocess** → the untrusted
  surface shrinks to `run_shell`, which is wrapped by the *same* `SandboxLauncher.wrap()` the codec
  harness uses. Net: the SDK harness gives **finer-grained** isolation than wrapping an opaque CLI.
- `makeHarness` passes the resolved `HarnessSandbox` (launcher + workspace + policy + proxy) into
  `SdkHarness`, which applies it inside the `run_shell` tool's exec only.

### 2.6 Edit reliability (the make-or-break of harness *quality*)
The loop is easy; **`edit_file` is where naive agents thrash.** Budget real effort here:
exact-match first, then whitespace-tolerant / fuzzy fallback, a clear "old_string not found / not
unique" error string that lets the model retry, and optional whole-file `write_file` as the escape
hatch. This single tool is the largest determinant of how many iterations a run takes. It gets the
heaviest unit-test table in the slice.

### 2.7 Registration edits (precise)
- `src/cli/args.ts`: `HarnessChoice = AgentCli | 'fake' | 'sdk'`; `parseHarness` accepts `'sdk'`;
  usage/help strings; new flags `--base-url <url>` and `--llm-api-key-env <NAME>` (default
  `OPENAI_API_KEY`). The harness model reuses the existing `--model` → `models.harness` thread.
- `src/cli/compose.ts`: `makeHarness` gains `if (choice === 'sdk') return new SdkHarness({ client,
  workspace, sandbox, model, timeouts, sessionStore, onEvent })`. `codecFor`/the `AgentCli` union are
  **untouched** (sdk is not a codec). `sandboxedHarnessExec` is bypassed for sdk (it sandboxes a
  codec command); the launcher is handed to `SdkHarness` for `run_shell` instead.
- Tests: `args` parses `--harness sdk` + new flags; `compose` builds an `SdkHarness`; the loop is
  proven with a `FakeLlmClient` (scripted `tool_calls`) and a fake exec/fs — **zero network, zero
  real shell** (TDD build order, AGENTS.md).

### 2.8 What it is NOT (scope guards for Slice 1)
No context summarization/compaction (turn cap is the bound; revisit only if runs overflow), no
multi-file atomic edits, no speculative parallel tool calls, no provider-specific prompt-caching
tricks. Ship the smallest loop that converges on simple goals and emits clean trajectories.

---

## 3. Roll-out (Slices 0 → 5)

| slice | ships | gate to advance |
|---|---|---|
| 0 | `LlmClient` + read-only `OpenAiLlmProvider` (`--llm-provider openai`) | provider runs judge/approver against an OpenAI-compatible endpoint, fully faked in tests |
| 1 | `SdkHarness` (`--harness sdk`) | converges on a handful of simple goals end-to-end; never rejects under hostile output; docs synced |
| 2 | eval bench + trajectory exporter | baseline numbers for sdk(frontier) **vs** claude-code on the same bench; labeled JSONL dataset produced |
| 3 | rejection-sampling SFT model | fine-tuned small model **beats the thin sdk baseline** on the bench |
| 4 | iterated improvement loop | retrained model shows monotone bench gains, no regression vs Slice 3 |
| 5 | productionized versioned model | `--harness sdk --model goaly-coder-vN` shipped; CI bench gates each new model |

Slices 0–1 are normal engineering. Slices 2–5 are the research arc and can pause/resume without
blocking the harness being useful (the SDK harness is shippable after Slice 1 on a frontier model).

---

## 4. The improvement arc — training a goaly-tuned model (Slices 2–5)

### 4.1 Slice 2 — instrument & benchmark
- **Trajectory exporter:** the run log already persists everything write-ahead; add an exporter that
  emits, per run, JSONL of `{system, messages, tool_calls, tool_results, final_status,
  ladder_outcome (per-rung), approver_verdict, iterations, diff_size, tokens}`. **The ladder +
  approver are the label — for free.**
- **Eval bench:** a fixed set of `(goal, verify-cmd[, rubric])` tasks — small, deterministic,
  ladder-checkable, **held out from any training data**. Metrics: pass@1 (ladder), iterations-to-
  converge, % approver-accepted, diff minimality, token/$ cost.
- **Baselines:** run `--harness sdk` on a frontier model, and `--harness claude`/`codex`, over the
  same bench. The gap quantifies how much training has to close.

### 4.2 Slice 3 — rejection-sampling SFT (the cheap first win)
- Generate many trajectories (bench tasks + synthetic goals) with a capable model through the SDK
  harness. **Keep only trajectories that PASSED the ladder + approver** (optionally also minimal-
  diff / few-iteration). That filtered set is high-quality SFT data, in *our exact tool schema*.
- Fine-tune a small open-weight coder (e.g. Qwen-Coder / Llama-class) via a provider FT API or local
  LoRA. Eval on the §4.1 bench.
- **Hypothesis:** on the narrow goaly distribution + our tool schema, the small fine-tuned model
  approaches the big model — cheaply, locally, and ours to keep.

### 4.3 Slice 4 — iterated improvement / RL (the bet)
The goaly loop **is** the environment: state = workspace + conversation; action = tool call; reward =
ladder pass. Two routes, escalating in infra cost:
- **Expert iteration (preferred first):** generate with current best → filter by ladder/approver →
  SFT → repeat (DAgger-style). Low infra, matches goaly's structure, strong empirically.
- **Online RL (GRPO/PPO-style)** if EI plateaus: policy generates trajectories, reward = terminal
  ladder pass **plus dense shaping** from the *ordered* rung progress (how far up the ladder it got),
  minus penalties for diff size, iteration count, and failed tool calls.
- **Reward-hacking note (advantage):** because the contract is frozen and the approver is an
  independent key, the policy **cannot** win by weakening the success criterion — the env resists the
  classic RL failure mode by design. Document this as a first-class property.

### 4.4 Slice 5 — productionize & keep improving
- Ship the model as a harness target: `--harness sdk --base-url <endpoint> --model goaly-coder-vN`.
  **The harness code does not change** — only the endpoint/model.
- **Continuous loop:** real goaly runs keep producing labeled trajectories → periodic retraining →
  versioned `goaly-coder-vN`, each gated by the §4.1 bench (no regression to ship).
- Frontier harnesses (`--harness claude`, etc.) remain the fallback/ceiling; the trained model is the
  cheap, fast, specialized default for the *common* goaly distribution, not a universal replacement.

---

## 5. Effectiveness & expectations (set them honestly)
- **Safety:** independent of harness quality — the two keys protect correctness; a weak harness costs
  *iterations*, never a wrong green.
- **Slice 1 on a frontier model:** handles simple, well-scoped goals; underperforms tuned CLIs on
  hard tasks (weaker `edit_file`, no context compaction, naive recovery). That's acceptable — its job
  is to bootstrap data.
- **Trained model:** the win is **cost / latency / specialization on the common distribution**, with
  frontier as fallback — *not* beating claude-code on arbitrary hard tasks. Small models may plateau
  below frontier on the long tail; set the goal accordingly.

---

## 6. Risks & open questions
- **`edit_file` reliability** is the dominant quality risk — over-invest in it and its test table.
- **Trajectory data provenance:** trajectories from real user repos carry privacy/licensing concerns
  → opt-in capture + env/secret scrubbing (`scrub-env` exists) + repo-content policy before any
  dataset leaves the box.
- **Distillation provenance:** generating SFT data by driving a *frontier CLI* may carry ToS issues →
  prefer trajectories generated through our own SDK harness / open models for the trainable dataset.
- **Bench overfit:** the eval bench must be strictly held out from all training/synthetic generation.
- **Infra cost of Slice 4 RL:** start with expert iteration; only escalate to online RL if it stalls.
- **`LlmProviderChoice`/`HarnessChoice` widening:** sdk/openai are the first non-CLI members of those
  unions — `independence.ts` family-matching and help/usage text must learn the new members.

---

## 7. Docs-sync gate (definition of done, per AGENTS.md)
Every slice that lands updates, in the same change:
- `README.md` — `--harness sdk`, `--llm-provider openai`, `--base-url`, supported-harness matrix.
- `docs/index.html` — support matrix + harness-comparison tabs + the "adding a harness" overview.
- `docs/adding-a-harness.md` — **grow a new "SDK / non-codec harness" path**; today it documents only
  the codec pattern. This is the first adapter that is *not* an `AgentCliCodec`.
- `AGENTS.md` — directory map (`src/llm-client/`, `src/sdk-harness/`), and the harness section noting
  the two adapter shapes (codec-backed vs SDK-native).
- An **ADR** per architectural decision: `docs/adr/00NN-sdk-native-harness.md` (the non-codec adapter
  + sandbox-at-tool-grain), and later `00NN-goaly-tuned-model.md` (the training env + reward design).

---

## 8. Suggested first move
Land **Slice 0** (the `LlmClient` + read-only `OpenAiLlmProvider`) — small, high standalone value,
and it is the harness's transport — then **spike Slice 1 as a throwaway** behind `--harness sdk` with
a `FakeLlmClient` in tests, run it against 2–3 simple goals, and measure *iterations-to-converge vs
claude-code*. That number decides whether the bootstrap is good enough to start collecting
trajectories (Slice 2) — cheap to learn, de-risks the whole training bet before committing to it.
