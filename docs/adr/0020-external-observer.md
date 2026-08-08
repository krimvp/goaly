# ADR 0020 — the external observer: out-of-band, trajectory-level judgment

## Status
Accepted as a direction. Layer A (read-only diagnostician) is the decision to build first; layer B
(bounded intervention) is pre-committed to the **existing** `RUN_EXTENDED` channel; layer C (a full
control plane) is rejected. Depends on [ADR 0019](0019-symmetric-threat-model.md). Discussion:
[#124](https://github.com/krimvp/goaly/issues/124).

## Context

[ADR 0019](0019-symmetric-threat-model.md) closed the false-red gap *inside* the graph: adjudicate a
defective bar, recover in a successor run, keep the state set closed. It left one piece untouched.

**Every judgment in goaly today is made by a node inside the graph, at the moment that node runs,
from that node's local evidence:**

| Judge | Sees | Blind to |
| --- | --- | --- |
| `classifyPreflightSoundness` | the tree at t=0 | everything after t=0 |
| `detectStuck` | `LoopCtx` histories | anything not in those histories; must stay pure + narrow (invariant #8) |
| judge rung / Sign-off approver | one iteration's tree | the shape of the run |

**Nobody watches the run as a trajectory.** #114 was diagnosable from trajectory shape alone: *the
same assertion signature redded across four iterations while the tree went from empty to 22/23 green,
and the file named in the failure is one the worker is structurally forbidden to edit.* No component
in goaly has standing to make that observation. `detectStuck` comes closest, but it is deliberately
pure, synchronous and narrow — correctly so; widening it would violate invariants #1 and #8.

So the missing thing is not another in-graph node. It is an observer **outside** the graph, watching
the whole trajectory.

## Decision

### 1. The write-ahead run log is the substrate

`.goaly/<runId>/log.jsonl` already records every transition — `contractHash`, verdicts, run statuses,
diff hashes, timings — durably, *before* the state advances (invariant #7,
[ADR 0006](0006-write-ahead-run-log.md)). `goaly runs watch` and `goaly ui` already tail it
([ADR 0012](0012-operator-control.md), [ADR 0014](0014-local-web-ui.md)). An observer needs **no new
plumbing**: it consumes that stream **out-of-band**.

A direct consequence, and a large part of why this shape was chosen: an observer is a **fold over
recorded events**, so it can be developed and regression-tested against **historical logs** — the
#114 log included — with no live run and no IO.

### 2. The safety property is structural, not conventional

> **An observer that reads the event log and can only emit veto-side or advisory signals is
> STRUCTURALLY incapable of producing a wrong-green — it has no edge into `DONE`.**

That is the same shape as the veto-only Sign-off approver ([ADR 0003](0003-two-key-approval.md)), the
precedent the project already trusts. It must remain a property of the **schema** — no observer output
type has a field that can turn a key — rather than a convention observed by its implementations.

### 3. Authority is **layered**, not a single overseer

The observer is not a supervisor bolted on top of goaly. It is one more layer in an authority
hierarchy that mostly already exists, and the principle *no single entity holds unilateral control*
is load-bearing:

| Layer | goaly today |
| --- | --- |
| Topology owner | the reducer's closed state machine ([ADR 0019](0019-symmetric-threat-model.md)) |
| Policy enforcement (read + intervene) | the verifier ladder + `GeneratedFilesGuard` |
| Human checkpoint at a high-consequence edge | the Seal gate / review station ([ADR 0016](0016-seal-review-station.md)) |
| Out-of-band intervention | `RUN_EXTENDED` markers ([ADR 0012](0012-operator-control.md)) |
| **Trajectory-level watcher** | **missing — this ADR** |

The trajectory observer is **one more layer, not a supervisor over the others**. It does not
arbitrate between them, cannot override the ladder, and cannot stand in for the human at Seal.

### 4. Build the read-only diagnostician first

The observer tails the event stream and emits **typed diagnoses** — contract defect, unsatisfiable
bar, timeout thrash, oscillation-with-progress — with **zero control authority**. It generalizes
#116: instead of wiring each new trajectory-level detector into DECIDE, the observer becomes the
**host** for them, and DECIDE stays a small pure truth table a person can read in one sitting.

Accepted cost, stated plainly: **it can only tell you.** An unattended run still ends badly, just
with a much better explanation. That is precisely why layer B below is pre-committed rather than
deferred indefinitely.

### 5. Promote to bounded intervention through the **existing** `RUN_EXTENDED` channel — never a new one

When the observer is allowed to act (inject a steering note, raise an operational cap, trigger a
guarded backward edge, abort early with a typed reason), it acts through the channel goaly has
**already built and secured**: Driver-side `RUN_EXTENDED` markers that `replay()` applies as a
config overlay *before* the fold and that are **never fed to `step()`**, whose schema has **no field
for the goal, verifier, or rubric** — so the frozen contract is unreachable through it by
construction ([ADR 0012](0012-operator-control.md)).

An observer under layer B is *that same channel driven by a program instead of a human*. It is
therefore far less radical than it sounds — the hard safety work is done — but a program acting on a
run is a genuinely new actor, so it inherits the full guard set:

- **Independent of the worker** — a separate authority, never the worker, never worker-selected.
- **Fed only on goaly-owned facts** — its own verdicts, statuses, hashes, diff hashes, timings.
  **Worker-authored text must not be an input**, or the worker gains an indirect channel to its own
  supervisor.
- **Budgeted, with an explicit cadence** — an observer that calls an LLM per event is a cost bug.
  Sampling/thresholding is part of the design, not an optimization, and the cadence is declared as an
  edge property ([ADR 0019](0019-symmetric-threat-model.md) §3).
- **Replayable** — every intervention is an event in the log; resume must reproduce it without
  re-running the observer.
- **Zod-parsed and fail-closed** — unparseable or errored observer output yields *no* intervention,
  never a permissive default.

**Adding a new intervention channel is out of bounds.** If a future need cannot be expressed through
`RUN_EXTENDED`, that is a signal to revisit this ADR, not to open a second door.

### 6. The full control plane is REJECTED

The maximal option — the graph becomes data, the observer schedules nodes, the reducer degrades to an
interpreter — is rejected, and recorded here so the rejection is explicit rather than implied. Two
independent reasons: it makes the edge set unbounded, so the eight invariants stop being checkable
properties ([ADR 0019](0019-symmetric-threat-model.md) §2); and it concentrates unilateral control in
one entity, which §3 rules out on its own.

## On the sourcing (recorded honestly)

This ADR's framing borrows vocabulary from "graph engineering", and the provenance deserves stating
plainly so no future contributor goes looking for a specification that does not exist:

**"Graph engineering" is a mid-2026 framing, not a specification.** The term is weeks old at the time
of writing (it followed "loop engineering" through mid-2026), a substantial part of the corpus is
content marketing, and **there is no canonical "external observer" primitive with defined semantics**.
Accordingly, **every decision above is derived from goaly's own architecture** — the write-ahead log,
the veto-only approver, the `RUN_EXTENDED` marker — and merely *informed* by three ideas from that
framing which do hold up:

1. **Evidence must come from outside the agent system.** "Tests that actually ran" — with the named
   failure mode being agents validating each other on identical models and context. goaly's verifier
   ladder is already a strong expression of this (deterministic rungs before any LLM judge,
   cheapest-and-hardest-to-game first, `--smoke` running the built artifact). The defect was in the
   **defaults**, where agent = judge = approver could resolve to a single model — the one thing the
   principle says must be external was internal (addressed in #125).
2. **Authority is layered.** An orchestrator owning topology, a policy layer in read + intervene
   mode, human approval at high-consequence edges, and explicitly *no single external entity with
   unilateral control*. That is §3, and it is what reframed this work from "add a supervisor" to
   "add a layer".
3. **Cadence.** "…and at what cadence" is the dimension goaly had no concept of: everything ran in
   lockstep, once per iteration. Fast local loops with slow authoritative ones — the slow one
   specifically guarding against overfitting to visible checks, which is this project's entire threat
   model. Adopted as a per-edge property in [ADR 0019](0019-symmetric-threat-model.md) §3.

One attribution could **not** be verified and is deliberately not relied upon: a "Graph Engineering"
PDF attributed to a well-known author, described secondhand as being about *knowledge graphs for
agent memory* — a different sense of "graph" from the execution/organization graph this ADR concerns.
The two should not be conflated.

## Consequences

- The observer lives entirely outside `src/orchestrator/`; the reducer, DECIDE and the stuck
  detectors are untouched, so invariants #1 and #8 are preserved by construction.
- Trajectory-level detection becomes testable the cheapest possible way: replay a recorded log,
  assert the diagnosis. New detectors cost a fold, not a state.
- Layer A improves an unattended run's **explanation** only. The outcome improvement is deferred to
  layer B, on purpose, so the safe half ships and gets validated against real logs first.
- Because interventions ride `RUN_EXTENDED`, they are auditable in `runs show` / `runs watch` / the
  UI for free, and durable across resume — the same properties the operator's own extensions have.
- A second consumer of the run-log schema means the log's event shapes become more load-bearing;
  additions stay backward-compatible on read, forward-incompatible for older goaly versions (the
  usual consequence of an event addition, unchanged).

## Reviewed and deferred

- **A dedicated observer intervention channel.** Rejected outright above, recorded here so it is not
  re-proposed as an implementation convenience.
- **Running the observer in-process, per iteration.** Deferred: cadence is the point, and an
  out-of-band consumer of the log is what makes offline development and regression testing possible.
  An in-process fast path is an optimization to consider only once the diagnoses have proven
  themselves.
- **Letting the observer author or refine the contract.** Never. It has no edge into `DONE` and no
  field for the bar; contract evolution is a successor-run concern
  ([ADR 0019](0019-symmetric-threat-model.md) §6).
- **A trained/learned trajectory judge.** The labeled-trajectory pipeline
  ([ADR 0009](0009-training-data-pipeline.md)) is the obvious substrate, but a learned observer needs
  its own calibration and trust story; start with typed, explainable detectors.
- **Observing across runs (a mission-level watcher).** The defect corpus (#122) is the slow loop that
  already spans runs; a genuinely cross-run observer should be designed on top of it rather than
  invented separately.
