# Lessons: prompt size, token usage, and decomposition in goaly

Notes from building **Paradox Foundry** with goaly inside a nested Claude Code sandbox. The headline:
goaly's correctness model is great, but a *single* run's prompts grow with the size of the change —
so big changes must be **decomposed**, and there's a clean primitive missing that would make that
automatic.

> Scope caveat: the hard *hang* below is specific to running goaly's harness/LLM steps **nested
> inside another `claude` process** in this remote environment. In an ordinary terminal the same
> large prompts don't hang — they just cost more tokens and march toward the model's context
> window. The *decomposition* lessons apply everywhere; the *hang* is the extreme version of a
> general truth: per-call prompt size is a first-class constraint.

## 1. Max token input — there is a per-call prompt ceiling

We measured the nested-`claude` call directly (same flags goaly uses):

| Prompt delivered | Result |
| --- | --- |
| ~0.3 KB ("reply OK") | returns in ~3–6 s |
| ~1.2 KB | returns in ~6 s |
| ~6 KB (our goal+intent+rubric) | **hung** (no response in 100–300 s), via **stdin *and* argv** |
| big input / tiny output ask | **hung** too |

So it's the **total input size**, not the delivery channel or the output size. Somewhere between
~1.2 KB and ~6 KB the nested call stops returning. No timeout helps — the call never completes.

**Why this bites goaly specifically:** three of goaly's four seams build prompts that scale with the
change:

- **compiler** (`--generate`): `goal + intent + rubric` (`src/compile/agent-compiler.ts`).
- **judge** rung: `goal + the FULL git diff` as untrusted data (`src/verify/judge.ts:110` →
  `workspace.diff()`).
- **Gate B approver**: `goal + rubric + the FULL diff + verdicts` (`src/verify/approver.ts`).

The judge/approver are the killers: they ingest the worker's entire `git diff HEAD` every iteration.
A big build ⇒ a big diff ⇒ a big prompt ⇒ overload (here, a hang).

**Practical rule:** keep each run's *goal/intent/rubric terse* and each run's *diff small*. Terse
inputs aren't cosmetic — they're load-bearing.

## 2. Token usage — it climbs as the codebase grows, and cache dominates

Per-increment totals for the staged Paradox Foundry build (harness on `opus`, LLM steps on `sonnet`):

| Increment | What it added | Tokens (total) |
| --- | --- | ---: |
| 1 | grid engine (`parseLevel`/`step`) | 392,739 |
| 2 | mining + inventory | 570,098 |
| 3 | time-loop echo replay | 944,269 |
| 4 | collision paradox | 2,204,024 |
| 5 | canvas renderer (new, isolated file) | 393,477 |
| 6 | playable `index.html` (new file) | 567,119 |
| — | **staged build total** | **~5.07 M** (+0.21 M on a failed step) |

Observations:

- **Cost rises with accumulated code.** Increments 3–4 touched/grew the central `engine.js`, so the
  harness re-read more context and iterated more (inc 4 alone ≈ 2.2 M). Editing a big shared file is
  the expensive case.
- **New, isolated files are cheap.** Increments 5 and 6 *added* `render.js` / `index.html` without
  reopening `engine.js` and cost ~0.4–0.6 M each — far less than the in-place edits.
- **Cache-read is the bulk of every total.** The per-run reports were dominated by `cache-read`
  (input + output were a tiny slice). goaly counts every category against `--budget-tokens`, which is
  correct, but it means the "token" number is mostly cache traffic, not fresh generation.
- **Fail-closed still costs tokens.** A step that fails late (e.g. the compiler emitting an absolute
  path → "refusing to write outside the workspace") still burns its compile tokens (~0.2 M here).

**Takeaways:** prefer **adding new files** over editing large ones; size increments so the *touched*
surface stays small; set `--budget-tokens` as a real guardrail; and separate concerns into modules
early so later increments don't have to reopen everything.

## 3. Decomposition — what actually worked

goaly computes its diff against the workspace git **HEAD** (`src/workspace/git-workspace.ts:158`,
`git diff HEAD`). So:

> **Commit after every `DONE`, and the next run's `git diff HEAD` only contains its own change.**

That single move keeps every compile/harness/judge/approver prompt small *while each increment still
gets the full frozen-contract, two-key treatment*. Paradox Foundry was built this way in six
increments (`staged-build.sh`, `built/RUN-LOG.txt`), each reaching two-key DONE.

Guidelines we converged on:

- **One concept per increment**, adding only a few KB of code (keep the diff well under the ceiling).
- **Terse goal/intent/rubric** per increment.
- **Mandate relative paths** in the intent (goaly fail-closes on writes outside the workspace).
- **Commit only on `exit 0`** (goaly's DONE exit code) so the baseline never advances on a red run.
- **Add files rather than rewrite them** when you can — cheaper and smaller-diff.

## 4. Supporting big changes — alternatives & improvements

Ideas, roughly ordered by leverage. Several would let goaly handle big changes *without* the caller
hand-decomposing.

### A. Shrink what the judge/approver ingest (highest leverage)
The diff is the prompt-size driver. Options:
- **Per-file / per-hunk verification:** judge each changed file (or hunk) separately and combine
  verdicts (map-reduce), instead of one monolithic diff prompt.
- **Summarized / truncated diff with full-content escalation:** send a structured summary (files,
  hunk headers, sizes) and let the judge *request* full content for the parts it cares about (tool
  use), rather than pushing everything every time.
- **Diff budgeting:** a `--max-diff-tokens` guard that splits or summarizes once the diff exceeds a
  threshold, and **fails loud** instead of hanging.
- Trade-off to respect: goaly deliberately feeds the **whole** diff as untrusted data so nothing
  hides from the two keys. Any chunking must preserve "no unreviewed bytes" (e.g. require every hunk
  to be covered by some judge call), or it weakens the anti-reward-hacking guarantee.

### B. A checkpoint primitive that isn't a user-visible commit (answers "do we have to commit?")
Today the *caller* commits between runs. goaly could own a **baseline ref** instead:
- **`--baseline <ref>`**: compute the diff against an arbitrary ref, not always `HEAD`.
- **Internal checkpoints without touching the branch:** advance a private ref
  (`refs/goaly/baseline`) using `git commit-tree` / `git update-ref` (or `git stash create`, which
  yields a commit object without moving `HEAD`). The user's branch and `HEAD` stay untouched; goaly
  diffs each run against the last checkpoint it took. This gives the "small diff per run" benefit
  with **zero commits on the user's history** — exactly the missing primitive.
- **Dedicated git worktree** per staged build so checkpoints never disturb the caller's tree.
- A `goaly squash` / export at the end to collapse the internal checkpoints into one clean commit.

### C. Within-run incremental diffs (delta, not cumulative)
Inside one run, every iteration currently re-diffs against `HEAD` (cumulative). goaly could diff each
iteration against the **previous iteration's** snapshot (the checkpoint from B), so even a long
single run keeps each judge/approver prompt to *that iteration's* delta. This makes one run survive a
large *cumulative* change as long as each step is small.

### D. Built-in decomposition / phased goals
`staged-build.sh` is a hand-rolled planner. goaly could support this natively:
- **Phased goals:** a goal file that declares ordered sub-goals; goaly runs each as a frozen
  contract, checkpoints (B) between them, and reports one combined two-key result.
- **A planner step** that decomposes a big goal into a DAG of small verified increments (each with
  its own authored contract), then executes them with checkpointing.

### E. Operational guardrails
- **Fail-fast on oversized prompts:** measure the assembled prompt and refuse (clear error) above a
  configurable ceiling, instead of stalling — turns the hang we hit into an actionable message.
- **Context-window/cost preflight:** estimate per-call tokens before sending; warn/split early.
- **Prefer-add heuristic** in guidance: nudge the harness to add modules rather than rewrite large
  files (cheaper, smaller diffs — matches §2).

---

### Appendix — the recipe that worked here

```
# terse inputs + commit between runs = small prompts, full two-key per step
for each small sub-goal:
  goaly run --generate --autonomous \
    --goal "<terse>" --intent "<terse; relative paths only>" --rubric "<terse>" \
    --harness claude-code --model opus --llm-model sonnet \
    --workspace "$WS" --max-iterations 5
  # goaly exits 0 only on DONE:
  git -C "$WS" add -A && git -C "$WS" commit -m "increment N"   # resets `git diff HEAD`
```

`opus` for the harness (the builder) and `sonnet` for the LLM steps (compiler/judge/approver) was the
sweet spot: capable building, fast/cheap verification, and an approver independent from the worker.
