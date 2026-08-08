# ADR 0019 — the threat model is symmetric: false-green AND false-red

## Status
Accepted. Frames the work already landed as #115 (compile-time positive control), #116 (in-loop
contract-fault adjudication), #117 (`--recontract` successor runs), #118 (FALSE-RED lens) and #122
(cross-run defect corpus). Discussion: [#121](https://github.com/krimvp/goaly/issues/121).

## Context

goaly's founding thesis is that *"until the goal is achieved"* must not collapse into *"until the
agent weakens its own test"*. The answer — compile the contract once, freeze it
([ADR 0002](0002-compile-once-then-freeze.md)), require two independent keys
([ADR 0003](0003-two-key-approval.md)) — is sound, and the machinery around it works.

It worked, and produced a worthless outcome. In the run behind #114 the freeze held, the tamper
guard held, the ladder stayed fail-closed, and no wrong-green was possible at any point. The
compiler had authored a frozen test containing an assertion **no implementation can satisfy**; the
worker wrote a **correct** implementation (22 of 23 frozen tests green, strict `tsc` clean, the CLI
verified by hand); the run ended `ABORTED`, exit 1, ~2M tokens, tree discarded.

The lesson cuts at the design's core:

> **Enforcing the target and choosing the target are different problems, and goaly had only solved
> the first.** A frozen wrong target is exactly as worthless as a gamed one — and strictly *more*
> expensive, because freezing converts a soft failure (the agent drifts, you notice) into a hard one
> (the run is unwinnable, silently, until the budget is gone).

Every guard in the codebase pointed one way. `CONTRACT_REDTEAM_LENSES`, the vacuity classifier,
`GeneratedFilesGuard`, the two-key rule, the frozen hash: all ask *"could this bar pass without the
goal being met?"* Nothing asked *"could this bar fail when the goal IS met?"* The threat model was
one-sided, and the false-red half is where autonomous runs quietly lose.

The discussion raised a second question alongside it: the pipeline is a forward-only chain
(COMPILE → SEAL → prepare → loop → terminal) and every failure mode found so far is really *"we
learned something at stage N that invalidates a decision made at stage M < N, and there is no edge
back"*. Should goaly therefore become a graph?

## Decision

### 1. State the threat model symmetrically (for the first time)

Two failures, both first-class:

| | definition | remedy |
| --- | --- | --- |
| **false-green** | the bar passes while the goal is not met | **prevented**, structurally: the frozen ladder plus a veto-only approver gate every edge into `DONE` |
| **false-red** | the goal is met while the bar fails | **detected, adjudicated, and recovered** — never by weakening the gate |

The remedies are deliberately asymmetric; the *status* is not. A run that ends in either is a defect
of goaly, not of the user. Recording this explicitly is half the point of this ADR: the asymmetry
used to be implicit, so every contributor reproduced it.

### 2. goaly **is** a state machine, and stays one

`step()` (`src/orchestrator/step.ts`) dispatches over a small, enumerable state set — `PLANNING`,
`AWAIT_PLAN_SEAL`, `ADVANCING_PHASE`, `RUNNING_WAVE`, `COMPILING`, `AWAIT_SEAL`, `PREPARING`,
`RUNNING_AGENT`, `VERIFYING`, `AWAIT_SIGNOFF`, `ADJUDICATING`, `DONE`, `FAILED`, `ABORTED` — and
`decide.ts` is an edge table written as a truth table. `step(state, event) → [state, Command[]]` is a
labeled transition system. So "loop vs. graph" was always a false choice: it is already a graph.

**A general or user-extensible graph engine is REJECTED.** The guarantee comes from the state space
being small and enumerable, because **the eight invariants are edge properties**:

- "two keys for DONE" is *every edge into `DONE` requires `ladder.pass && !veto`*;
- "compile once, then freeze" is *no edge after `AWAIT_SEAL` mutates `contractHash`*.

With a fixed state set those can be verified by inspection and exhausted with table tests — which the
repo already does. An unbounded edge set makes them uncheckable: they stop being properties and
become hopes. The product *is* the guarantee, and guarantees come from constraint; a
composable-graph rewrite would trade the entire value proposition for generality nobody asked for.

The state set **stays closed and enumerable**. It was 13 states when #121 was written; closing the
false-red gap added exactly **one** (`ADJUDICATING`, #116). That is the intended cost model — one
named, reviewed edge at a time, never an extension point.

### 3. "Go graph" is adopted as an **analysis** model

Rejected as an execution model, adopted as an analysis model. The cheapest and most valuable version
of graph-thinking here is to **reify the transition table as data** — `(fromState, event, guard,
toState, cadence)` in one table — and assert the invariants as **property tests over the edge set**
rather than over hand-picked scenarios:

- no edge reaches `DONE` without both keys;
- no edge after Seal mutates `contractHash`;
- every **backward** edge carries the four guards in §4.

That converts the eight invariants from prose in `AGENTS.md` into executable constraints, and makes
adding a backward edge safe by construction rather than by review. It is a no-behavior-change
refactor: purely making explicit what `step.ts` already encodes.

**Cadence is a per-edge property.** goaly historically ran everything in lockstep, once per
iteration; cadence (per-iteration / once-per-run / once-per-chain / sampled) is the design variable
that lets fast local loops coexist with slow authoritative ones — the defect corpus (#122) is a very
slow loop, the critic panel is once-per-compile, and a trajectory observer
([ADR 0020](0020-external-observer.md)) must not run per-iteration. Cadence belongs in the edge
table, not in each component's private throttle.

Separately: the **phase plan** is the one place a *data* graph buys capability rather than structure
— a dependency graph over sub-goals, landed as `dependsOn` + topological scheduling (#123). That is a
different graph from the state machine and does not weaken this decision.

### 4. Backward edges are added individually, each with four guards

Not a general escape hatch. Each backward edge is named, and each carries **all four**: a
**hard-evidence trigger**, an **authority independent of the worker**, a **monotonicity guarantee**,
and a **bounded budget**.

| Edge | Trigger (hard evidence) | Independent authority | Monotonicity guarantee | Budget |
| --- | --- | --- | --- | --- |
| loop → adjudicate → successor COMPILE | adjudicated contract defect (#116) | adjudicator ≠ worker | the new bar must still red on the run-start baseline | `--max-recontracts` (#117) |
| loop → PLAN | phase plan proven wrong | planner ≠ worker | goal unchanged | `--max-plan-revisions` |
| loop → steer (operator) | operator note | human | contract untouched *by construction* | `RUN_EXTENDED` ([ADR 0012](0012-operator-control.md)) |

Every such edge must also be replayable from the write-ahead log without re-calling an LLM
(invariant #7), and enters the reducer as a Command → effect → Event, never as IO in `step()`
(invariant #1).

### 5. The goal is frozen absolutely; the contract is a fallible **derived** artifact

The generalization that makes the rest coherent: **the target may be revisited; the goal may not.**
The goal is the user's, frozen absolutely — nothing in goaly may revisit it. The contract is
*derived* from the goal by a fallible authority (the compiler). Treating a derived artifact as
though it were as sacred as its source is precisely what makes a bad derivation fatal. Invariant #2
was protecting the right thing at the wrong level of abstraction; this ADR fixes the level without
loosening the invariant (see §6).

### 6. Contract evolution happens **between** runs, never within one

**Mid-run contract mutation is REJECTED, and recorded here as rejected** so the "why not just patch
the contract?" question is answered once (see *Alternatives*). Invariant #2 keeps its strictest
form: **one run, one frozen contract, for the run's whole life.**

Evolution moves outward instead. A defective bar terminates its run with a typed
`CONTRACT_DEFECTIVE` (#116), and a **successor run** (`--from-run <id> --recontract`, #117) inherits
the tree, re-authors the bar with the defect report as feedback, and freezes a **new** contract with
a **new hash** and recorded ancestry; the adjudicated defect also feeds the cross-run corpus (#122)
so future authoring starts from it. The **run** owns exactly one contract identity; the **chain of
runs** owns contract evolution.

That yields the guarantee in one sentence a user can believe:

> The bar can only be *replaced* — never edited — by an authority independent of the worker, only to
> remove an adjudicated defect, only in a successor run with a new hash and recorded ancestry, and
> only if the new bar still rejects the starting tree.

## Honoring the invariants

- **#1 zero-LLM reducer.** `ADJUDICATING` issues exactly one read-only Command and accepts exactly
  one event (`CONTRACT_ADJUDICATED`); anything else is a fail-closed `invalidTransition`. The
  adjudicator itself is a Driver-side effect.
- **#2 compile once, then freeze.** Strengthened in spirit, unchanged in letter: nothing mutates a
  frozen contract. A successor run compiles and freezes its **own** contract.
- **#3 two keys for DONE.** Untouched. Nothing in this ADR creates or relaxes an edge into `DONE` —
  adjudication only *relabels an abort*, it can never turn a key.
- **#4 fail-closed.** An adjudicator that errors or returns unparseable output leaves the terminal
  outcome exactly as it was (an abort stays an abort, merely unrelabelled). A false-red remedy can
  cost a re-authoring, never a green.
- **#6 parse at every seam.** The adjudication verdict, the `CONTRACT_DEFECTIVE` reason, and the
  successor's ancestry all round-trip through Zod.
- **#7 write-ahead + resume.** Every new edge is durable in the log and replayable without an LLM.

## Consequences

- The false-red half of the threat model now has machinery, not just sympathy: a FALSE-RED /
  satisfiability lens at author time (#118), a compile-time positive control that proves the frozen
  bar *can* go green (#115), in-loop adjudication (#116), successor recovery (#117), and a cross-run
  defect corpus (#122).
- Recovering from a defective bar no longer means hand-editing a `GeneratedFilesGuard`-pinned file —
  i.e. deliberately defeating the guarantee, which was strictly worse than any option considered.
- Terminal outcomes should be **graded**, not binary: an `ABORTED` run that reached 22/23 rungs with
  a defective bar must say so loudly and hand back the tree. Reporting is part of the remedy.
- Owed work, recorded so it is not mistaken for colour: the **reified edge table** with the invariant
  property tests and the **cadence** column does not exist yet. Until it does, the invariants remain
  prose plus table tests.
- Adding a state is now an explicit, reviewable act with a stated cost model, rather than an
  architectural drift question re-litigated per feature.

## Alternatives considered

- **Immutability → monotonicity: guarded *in-run* contract revision. REJECTED.** Permit a mid-run
  change when it is authored by an independent authority, justified by a typed adjudication, proven
  "no weaker" (still red on the baseline and on every checkpointed tree the old bar redded on), and
  hash-chained. This is the honest articulation of what the failure asks for, and it reopens exactly
  the attack surface immutability closes: "prove no weaker" is easy to state and hard to guarantee —
  the checks are heuristics, and a motivated or merely sloppy revision could slip a weakening past
  them. §6 (successor runs) is its safe form: the same recovery, with no weakening channel anywhere
  inside a run.
- **A general graph engine / extensible node set. REJECTED.** §2. The invariants are edge properties;
  an unbounded edge set makes them unverifiable. The concrete gap that started this was **one edge**
  — a feature, not an architecture. (Rejected again, from a second direction, in
  [ADR 0020](0020-external-observer.md) §6.)
- **Do nothing structural; keep hardening the compiler. INSUFFICIENT ALONE.** Better prompts, more
  lenses, a positive control. Cheap and genuinely valuable — adopted as a complement (#115, #118) —
  but it only shrinks the *probability* of a bad target; it does not change what happens when one
  gets through, which is still "burn the run".
- **Grade the outcomes. ADOPTED, independently.** Nearly free, helps regardless of the rest, and
  deliberately not coupled to any of the above.
