# Architecture decision records

The decisions behind goaly, in order. Each one was hard to reverse, surprising, or a real trade-off —
if a change would contradict one of these, read it first and amend it in the same change.

Start with 0001–0003 (the trust model), then [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (how).
[`docs/README.md`](../README.md) routes every other question.

| # | Decision |
| --- | --- |
| [0001](0001-wrapper-over-hooks.md) | Wrapper over hooks — a portable headless `run()`; hooks are an in-adapter optimization |
| [0002](0002-compile-once-then-freeze.md) | Compile the contract once, then freeze it — the anti-reward-hacking core |
| [0003](0003-two-key-approval.md) | Two-key approval — frozen verifier ladder + an independent, veto-only approver |
| [0004](0004-pure-reducer-driver-split.md) | Pure reducer + Driver split — zero-LLM-in-control-flow as a *type-level* guarantee |
| [0005](0005-zod-parse-at-every-seam.md) | Zod parse-don't-validate at every seam, branded ids |
| [0006](0006-write-ahead-run-log.md) | Write-ahead run log as the source of truth for resume |
| [0007](0007-sandboxing-model.md) | Sandboxing model — one resolved `SandboxProfile`, per-launcher translation (`--sandbox`) |
| [0008](0008-goaly-code-harness.md) | `goaly-code` — an SDK-native (non-codec) harness over OpenAI-compatible endpoints |
| [0009](0009-training-data-pipeline.md) | Training-data pipeline — labeled trajectories, rejection-sampling SFT, eval bench |
| [0010](0010-prepare-from-scratch.md) | The prepare phase is from-scratch-aware |
| [0011](0011-reliability-hardening.md) | Reliability hardening — fail closed, but don't fail eagerly |
| [0012](0012-operator-control.md) | Operator control — watch, steer, extend (without touching the bar) |
| [0013](0013-named-worktrees.md) | Named worktrees — run goaly on an isolated copy of the repo |
| [0014](0014-local-web-ui.md) | A local web UI over the run log (`goaly ui`) |
| [0015](0015-ui-owned-runs.md) | UI-owned runs — start, gate, stop, resume from the browser |
| [0016](0016-seal-review-station.md) | The Seal review station — manual artifact edits, re-frozen before approval |
| [0017](0017-cooperative-parallel-waves.md) | Cooperative parallel waves (`--parallel-phases`, experimental) |
| [0018](0018-non-git-workspace.md) | Non-Git workspace support |
| [0019](0019-symmetric-threat-model.md) | The threat model is symmetric — false-green **and** false-red; the state set stays closed; contracts evolve between runs |
| [0020](0020-external-observer.md) | The external observer — out-of-band, trajectory-level judgment over the run log |
