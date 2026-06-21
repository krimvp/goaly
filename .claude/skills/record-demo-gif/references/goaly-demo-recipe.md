# Recording a goaly demo

goaly-specific recipe for `record-demo-gif`. The generic pipeline (asciinema → agg, pacing,
uploading) lives in `../SKILL.md`, `pacing-and-framing.md`, and `uploading.md`. This file is the
**goaly part**: how to drive `goaly run` in a recording so the loop's story — the **frozen
contract**, the **verifier ladder**, and the **two keys for DONE** — actually shows up on screen.

Two helpers ship next to this doc:

- `make-goaly-sandbox.sh <dir>` — a fresh throwaway git repo (buggy `sum()` + failing `node --test`
  + `GOAL.md`). The standard demo subject.
- `reveal-runlog.py <workspace>` — decodes `.goaly/<runId>/log.jsonl` into a compact
  compile → agent → verify → approve → DONE reveal. goaly writes the LLM steps to the run log, **not
  the terminal**, so this is how you make the LLM side visible in the GIF.

## Prerequisites

- The harness CLIs you want to show must be installed **and authenticated**: `claude`, `codex`,
  `droid`. The LLM steps (compile / judge / approve) shell out to a provider CLI (`claude -p` by
  default), which must also be authenticated.
- A runnable `goaly`. Either `make install` (puts `goaly` on PATH) or, for a no-install demo, build
  `dist/` and define a wrapper in the demo script's hidden setup:
  ```bash
  npm run build >/dev/null 2>&1
  goaly() { node "$(git rev-parse --show-toplevel)/dist/goaly.js" "$@"; }
  ```
  Echo the command as `goaly run …` so the viewer sees the real CLI, not `node dist/…`.

## Four gotchas that will silently ruin the recording

1. **Run goaly FROM INSIDE the sandbox.** The harness adapters spawn the agent CLI in
   `process.cwd()`, **not** in `--workspace` (which only governs diff-hashing + `--verify-cmd`).
   `--workspace` defaults to cwd, so `cd` into the sandbox and don't pass `--workspace`. Get this
   wrong and the agent edits the wrong tree → the workspace shows no diff → `no-diff` ABORT (and the
   agent may scribble in *your repo*).
2. **The sandbox must be a git repo.** `GitWorkspace` diff-hashes via `git add -A`/`git write-tree`.
   `make-goaly-sandbox.sh` `git init`s for you.
3. **codex needs a writable, trusted path.** The `codex` harness runs `codex exec --full-auto`
   (workspace-write). Put the sandbox under a codex-trusted root (your usual workspace dir), not a
   random `/tmp` path, or codex's sandbox may block writes.
4. **Use `--autonomous`.** A recording can't answer the interactive Gate-A prompt. `--autonomous`
   auto-approves but **still freezes the contract and logs it loudly** (`AUTONOMOUS: auto-approving
   frozen success contract …`), so the headline feature is still on screen.

## Pacing for real agent runs

A `goaly run` prints the frozen-contract banner, then goes **silent for seconds-to-minutes while the
agent works**, then prints the outcome. agg clips that silent gap to `--idle-time-limit` (default
3s), so the GIF stays tight — but the wall-clock recording really does take that long. Two options:

- **Stream it live** (simplest): just run `goaly run …`; the idle gap compresses automatically.
- **Capture + curate** (cleaner for multi-run demos): redirect to a file, then show only the salient
  slices — the contract `rungs`, the outcome, and `reveal-runlog.py`. Trims the verbose banner.
  ```bash
  goaly run … > /tmp/run.out 2>&1 || true
  sed -n '/SUCCESS CONTRACT/,/===========/p' /tmp/run.out   # the frozen contract
  grep -E 'status:|iterations:' /tmp/run.out                # the outcome
  ```

Keep `--max-iterations` low (2–3); the demo goal is one-shot for every harness.

## Variant A — deterministic verification (the fast, fully-reproducible one)

`--verify-cmd "node --test"`: the contract is one deterministic rung. Compile does **no** LLM call,
so the `contractHash` is **identical across all three harnesses** — a clean "same frozen contract,
any harness" story. Per harness: `fresh sandbox → goaly run → DONE → show the diff → re-run the
verify cmd (✓)`.

```bash
for H in claude-code codex droid; do
  bash references/make-goaly-sandbox.sh "$DEMO" >/dev/null 2>&1; cd "$DEMO"
  goaly run --goal-file GOAL.md --verify-cmd "node --test" --harness "$H" --autonomous --max-iterations 3
  git --no-pager diff -- sum.mjs          # what the agent changed
  node --test >/dev/null 2>&1 && echo "✓ verify passes → DONE"
done
```

## Variant B — LLM-authored & LLM-judged verification (shows the whole LLM side)

`--generate` + `--rubric`: goaly's **compiler LLM** authors and freezes the contract, the verifier
ladder adds an **LLM judge** rung (quorum, runs after the deterministic rung passes), and the
**independent Gate-B approver** (LLM, veto-only) holds the second key. Steer the compiler so it stays
reproducible:

```bash
INTENT="The verification command MUST be exactly: node --test. Do NOT author new files. Put the
genuine-implementation requirement in the rubric for the LLM judge."
RUBRIC="sum(a,b) must genuinely return a+b for arbitrary inputs (not hardcoded/test-specific
values), and the existing tests must not be weakened. Keep it to 2-3 sentences."

goaly run --goal-file GOAL.md --generate --intent "$INTENT" --rubric "$RUBRIC" \
          --harness "$H" --autonomous --max-iterations 3 > /tmp/run.out 2>&1
python3 references/reveal-runlog.py "$DEMO"   # ← the verify beat: judge + approver = two keys
```

This is the better anti-reward-hacking story: a deterministic test can be gamed by hardcoding, but
the LLM judge + independent approver are the keys that catch it. The `--generate` output is
LLM-authored, so dry-run it once and confirm the command lands on `node --test` before recording.

## Always dry-run first

Per the skill checklist: **a demo proves success**. Run each harness once (not recorded) and confirm
it reaches `DONE` before you record — real agents are nondeterministic. If a run ABORTs `no-diff`,
re-read gotcha #1 and #3.
