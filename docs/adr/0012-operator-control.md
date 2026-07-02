# ADR 0012 — operator control: watch, steer, extend (without touching the bar)

## Status
Accepted.

## Context

After the reliability hardening ([ADR 0011](0011-reliability-hardening.md)), a run survives crashes,
blips, and Ctrl-C — but the *operator* still had almost no agency over one:

1. **During a run you were blind unless you had remembered `--stream` at launch.** From another
   terminal (or after starting a run and walking away), there was no way to see what iteration the
   run was on, what the verifier said, or why the approver kept vetoing. The write-ahead log held
   all of it; nothing surfaced it live.
2. **A run that ended at an operational limit was a dead end.** `--resume` is a replay-fold over the
   log using the HEADER's config, so a run that FAILED at `maxIterations`, ABORTED on budget, or
   tripped a stuck detector replayed straight back to the same terminal state — passing
   `--max-iterations 25` on resume was silently ignored. The `next:` hints introduced in ADR 0011
   ("raise the cap and resume") were therefore aspirational, not real. The only continuation was
   `--from-run`: a full recompile of a NEW contract, losing the frozen contract's continuity and
   paying compile again — the wrong tool when the goal hasn't changed and the run just needs room.
3. **There was no way to hand the worker guidance mid-run.** A human watching the agent circle a
   wrong approach could only kill the run and start over; the graceful-interrupt path (ADR 0011)
   made stopping safe but resuming carried no new information.

The tension: goaly's entire value is that the agent *cannot* renegotiate its success criterion
(invariant #2, compile-once-then-freeze; invariant #3, two keys). Any operator-control surface must
make it impossible to weaken the bar through it — otherwise "extend the run" becomes the very
loophole the freeze exists to close.

## Decision

Give the operator three capabilities, each built so the frozen contract is **structurally** out of
reach.

### 1. `goaly runs watch <runId>` — live, read-only observation
A poll-tail of the run's write-ahead log from any terminal: one human line per event (contract
frozen, seal, each agent turn / verifier verdict / sign-off veto, operator extensions). It never
takes the run lock and never mutates — the torn-tail-tolerant reader (ADR 0011) makes concurrent
reads of a live log safe. Exit 0 at a terminal state; exit 1 (naming the resume command) when the
run is incomplete and no live process holds its lock. The startup banner names the command so the
capability is discoverable exactly when it's useful.

### 2. `--resume` extensions — raise the *operational* caps, auditable, replay-faithful
A resume may carry explicitly-passed cap flags (`--max-iterations`, `--budget-tokens`,
`--budget-wall-ms`, the `--stuck-*` thresholds). They are persisted write-ahead as a
**`RUN_EXTENDED` marker** — the same class of Driver-side marker as `CHECKPOINTED` /
`CANDIDATE_*`: **never fed to the pure reducer**. Instead, `replay()` applies extensions as a
config **overlay before the fold**, so a raised cap simply makes the fold not terminate at the old
one. That single mechanism revives every operational terminal state:

- FAILED at `maxIterations` — DECIDE reads the effective cap;
- budget ABORTED — the persisted `exceeded` flags are re-judged against the new cap (the raw spent
  numbers remain the facts; prior spend still counts — extending is "more budget," never "amnesty");
- stuck aborts — the operator raises/toggles the tripped detector for this run.

Because the marker is in the log, the extension is **auditable** (`runs show`/`watch` render it),
**durable** (a later plain resume keeps it — the fold is the single source of truth), and
**replay-faithful** (resume, inspection, and watch all fold the same effective config). The CLI
composes a resumed run's deps from the log's effective config too, so the live budget meter and the
fold can never disagree. Config-file defaults never become extensions — only explicit CLI flags do
(an extension is a per-invocation operator act).

**What is structurally impossible:** the `RUN_EXTENDED` schema has fields for caps, thresholds, and
a note — the goal, verifier, rubric, and contract are not representable in it. Extending can add
*room*, never *lower the bar*. A DONE run refuses to extend (both keys already turned) and routes to
`--from-run`.

### 3. `--note` — steer the worker, not the contract
`--resume <id> --note "<guidance>"` records the note on the same marker; the Driver appends it to
the **next agent prompt** (clearly labeled as an operator note). Consumption is positional and
deterministic — a note with no `AGENT_RAN` after it in the log is pending; once a turn runs after
it, later replays no longer surface it — so re-resumes never double-inject. The note decorates the
prompt the reducer already built, at perform time: the reducer, the ladder, the judge, and the
approver never see it as anything but worker context. Combined with the graceful interrupt this
yields mid-run steering: `Ctrl-C` → `goaly --resume <id> --note "try the other approach"`.

The division of labor stays exactly as DESIGN.md drew it: the human owns the **contract** (Seal)
and now also the **operational envelope** (caps, steering); the machine owns the loop and the
verdicts. `--resume` + extension is "same goal, more room"; `--from-run` remains "new/refined goal,
new contract".

## Consequences

- The `next:` hints are now real commands: every "…and continue" names the exact extension flag
  that revives that terminal state (corrected in the same change — a plain resume replays to the
  same terminal state by design).
- The reducer is untouched (invariant #1): `step()` never sees a `RUN_EXTENDED`; if one ever
  reached it, every state handler throws `invalidTransition` (fail-closed).
- Old logs replay unchanged (no markers → identity overlay). New logs carry a new event variant, so
  goaly versions BEFORE this ADR reject them on read — the usual forward-schema consequence,
  consistent with prior event additions.
- `iterations` in an extended run counts across the whole run (replayed + revived), so reports stay
  monotonic and comparable.
- Wall-clock budget still restarts per process (ADR 0011); `--budget-wall-ms` as an extension
  re-judges only persisted snapshots' flags.

## Reviewed and deferred

- **Interactive in-run controls** (a keypress to pause/steer without Ctrl-C; a `goaly attach` REPL).
  The Ctrl-C → `--resume --note` composition covers the need with far less machinery; revisit if
  real usage shows the round-trip is too slow.
- **Web/TUI dashboard over the log.** `runs watch` is deliberately the smallest observable surface;
  the same projection could back a richer UI later.
- **"Forgive one stuck abort" semantics** (a note alone reviving a stuck run, without raising the
  detector). Rejected for now: it would need the reducer to know about extensions (or replay to
  synthesize forgiveness), and raising the specific tripped threshold is explicit about what the
  operator is overriding.
- **Extending judge quorum / approver panel on resume.** Those are wiring, not caps; changing them
  mid-run has verification-semantics implications that deserve their own decision.
