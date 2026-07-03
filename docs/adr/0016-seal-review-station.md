# ADR 0016 — the Seal review station: manual artifact edits, re-frozen before approval

## Status
Accepted.

## Context

The Seal is the review moment before any execution — but it showed only a **summary**. On a
`--generate` run the compiler authors real verification files to disk, yet the gate (CLI banner and
the goaly-ui modal alike, ADR 0015) listed them as *paths*: the operator was asked to approve a bar
whose content they had not seen. And the one thing a reviewing operator most wants — *fix the small
thing myself* (tighten an assertion, adjust the setup command, add a flag to the verify command) —
was actively punished: the contract pins each authored file's content hash
(`generatedFiles[].sha256`, part of `contractHash`), and the `GeneratedFilesGuard` rung runs first
in the ladder, so any manual edit after compile reds every iteration forever. The only sanctioned
change channel was `revise` — an LLM re-author, imprecise for surgical edits and bounded by
`maxSealRevisions`.

The tension: the freeze must stay absolute (invariant #2 — the anti-reward-hacking core), the
reducer must stay pure (invariant #1), and yet a *pre-approval* operator edit is exactly the kind
of human authority the Seal exists to provide.

## Decision

### A fourth Seal decision: `edited` → a Driver-side refreeze

`SealDecision` gains `{ kind: 'edited', patch?: SealEditPatch }`. The reducer handles it exactly
like `revise` structurally — transition `AWAIT_SEAL → COMPILING` and emit one data-only Command,
`REFREEZE_CONTRACT { contract, patch? }` — but the Driver performs a **refreeze** instead of an
LLM re-author: re-read every authored file from the workspace (the on-disk content IS the
operator's edit), re-pin each `sha256`, apply the field patch, `freezeContract` (a NEW
`contractHash`), and return a normal `CONTRACT_COMPILED`. The refrozen contract is therefore
write-ahead logged (the whole edit history is auditable), the ladder is rebuilt for it (the cached
guard would otherwise pin stale hashes), and the gate re-presents it under a fresh id.

**Invariants.** #1: the reducer only names the effect over data it already holds; all IO/hashing is
Driver-side, exactly like `COMPILE_VERIFIER`. #2: nothing mutates a frozen contract — each round
freezes a *new* one, and only the one the human finally approves enters the loop; post-approval
nothing changes. #5: `AutoSealGate` never emits `edited`, so `--autonomous` is untouched. #6: the
new kind and patch are Zod schemas parsed at the log and wire seams. #7: every refreeze is a logged
`CONTRACT_COMPILED`.

### The patch is field-scoped — and the goal is unrepresentable

`SealEditPatch` = `{ setup?: string|null, rubric?: string, commands?: [{index, command}] }`,
`.strict()`. It deliberately has **no `goal` field** (the RUN_EXTENDED trick): a goal change
re-scopes the run and goes through `revise`, where the LLM re-authors verification to match.
Command edits must index an existing *deterministic* rung; any invalid entry fails the whole
refreeze closed — never a silent partial apply.

### Unbounded rounds, zero revise-cap cost

`edited` does not touch `reviseRound` and resets `compileRound` (like `revise`, issue #51). The
revise cap exists to bound LLM spend; a refreeze costs zero tokens and each round requires an
explicit human action at a gate that already waits unboundedly. Corollary: `[e]dited` is offered
even when `--max-seal-revisions 0` disables feedback revision.

### Refreeze failure → `COMPILE_FAILED`, riding the existing retry machinery

A missing/unreadable/out-of-root pinned file or an invalid patch becomes a typed
`COMPILE_FAILED { reason: 'refreeze failed: …' }` — loud in the log, visible in
watch/`runs show`/the UI, and flowing through the bounded compile-retry path whose recovery output
is *re-presented at the Seal*, never executed unseen. Documented caveat: on a `--generate` run that
recovery recompile may re-author files over manual disk edits — acceptable because a human reviews
the result before anything runs.

### The UI review station

The goaly-ui Seal modal renders every artifact **by content**: `GET
/api/runs/:id/gate/:gateId/files` serves each pinned file's content (capped at 100k chars with a
`truncated` flag; `dirty` computed from the FULL-content hash so truncation never lies), and `PUT`
saves in-browser edits through the same guarded, git-excluding writer the compiler uses — with the
writable paths **allowlisted to exactly the parked contract's `generatedFiles`** (checked before
the traversal guard). Setup, deterministic rung commands, and the rubric are edit-in-place; the
pure `buildSealPatch` diff produces a minimal patch. "Re-freeze & review" saves + answers `edited`;
"refresh from disk" answers `edited` bare (picking up own-editor edits). **Approve-time drift
check** (UI only, UX not safety — the guard rung would red a drifted file at iteration 1 anyway):
approving a seal whose files no longer match their pins is refused 409 with the file list, and the
gate stays parked. The CLI's `[e]dited` prompt answer is the same mechanism without the patch.

### Plans are excluded

Manual editing applies to contract artifacts only. The shared schema admits `edited` structurally
at the plan Seal, so it is refused at both layers: `UiGates.resolve` returns a typed `invalid`
(→ 400), and `stepAwaitPlanSeal` maps a hand-crafted event to a typed `ABORTED` — pure, total,
fail-closed defense in depth.

## Alternatives considered

- **Gate-internal edit loop** (the gate re-presents privately and returns one decision) — rejected:
  the approved contract must be the one in the reducer's state and the log; a privately re-frozen
  contract would leave stale hashes in both.
- **Reusing `revise` with a sentinel feedback string** — rejected: it consumes the revise cap,
  invokes the LLM, and hides a distinct human act inside an unrelated decision kind; the log would
  not distinguish "the human edited" from "the LLM re-authored".
- **Allowing goal edits in the patch** — rejected: a goal change invalidates the authored
  verification; making it unrepresentable routes it to the channel that re-authors coherently.

## Consequences

- The exhaustive `SealDecision` switches (reducer ×2, gates, `toSealDecision`, `fmtSealDecision`)
  gained a case each — TypeScript enforced the inventory.
- `Workspace` gained `readFile` (mirroring `fileHash`'s guard); the guarded workspace-file
  read/write helpers moved to `src/workspace/workspace-files.ts` — one traversal boundary shared
  by the compiler's writes, the Driver's refreeze reads, and the UI's gate-file routes.
- `runs show` renders the audit trail: `seal: edited (manual refreeze) → approve`, with each
  refrozen contract's hash logged on its own `CONTRACT_COMPILED` entry.
- Resume semantics need nothing new: a log cut after `SEAL_DECIDED{edited}` re-performs the
  refreeze (at-least-once; the result is only re-presented at a gate); a cut after the refrozen
  `CONTRACT_COMPILED` re-parks the gate on the refrozen contract.
