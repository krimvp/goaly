# How a run works

This page gives the order of one run. Start with the [first run](first-run.md) if you have not
used goaly. Use the [reference](reference.md) for exact flags and defaults.

## 1. State the goal and the bar

The **goal** says what the worker should change. The **contract** says what goaly will check.
You can supply a command with `--verify-cmd`, or let `--generate` author verification. The
contract contains an ordered verifier ladder, a rubric, and a content hash. Goaly compiles it
once. At **Seal**, the operator approves it, or the selected mode auto-accepts it. Later worker
turns cannot revise the frozen bar.

Read [contract and Seal](reference.md#seal-the-contract-gate), then
[ADR 0002](adr/0002-compile-once-then-freeze.md). In code, start at
[`src/domain/contract.ts`](../src/domain/contract.ts),
[`src/compile/agent-compiler.ts`](../src/compile/agent-compiler.ts), and
[`src/orchestrator/step.ts`](../src/orchestrator/step.ts).

## 2. Prepare once, then run the worker

After Seal, goaly runs one-time preparation when the contract calls for it. This can include
workspace setup and a check that authored verification can run.
The **harness adapter** then asks the coding agent to work on the goal. A harness may wrap an
external CLI or run goaly's own agent loop. The worker can change files. It does not decide
whether the run is DONE.

Read [setup and preflight](reference.md#setup-preflight--soundness) and
[harnesses](reference.md#harnesses). Follow [`src/driver/prepare.ts`](../src/driver/prepare.ts),
[`src/harness/adapter.ts`](../src/harness/adapter.ts), and
[`src/cli/compose-harness.ts`](../src/cli/compose-harness.ts). For the design reason, read
[ADR 0001](adr/0001-wrapper-over-hooks.md).

## 3. Check each result with two keys

The **verifier ladder** runs its checks in order and stops at the first failure. An error is a
failure. Only a passing ladder requests **Sign-off**. The approver can veto a passing result; it
cannot turn a failed check into a pass. DONE needs a passing ladder and no veto. A DONE result
reports what these checks found. It is not proof of semantic correctness; the result depends on
the checks and the independence of the models.

Read [the verifier ladder](reference.md#the-verifier-ladder),
[Sign-off](reference.md#the-sign-off-approver-does-not-inherit---model), and
[ADR 0003](adr/0003-two-key-approval.md). Follow
[`src/verify/ladder.ts`](../src/verify/ladder.ts),
[`src/orchestrator/step.ts`](../src/orchestrator/step.ts), and
[`src/orchestrator/decide.ts`](../src/orchestrator/decide.ts).

## 4. Continue, stop, or resume

If a check fails or Sign-off vetoes, goaly sends the reason to the next worker turn. The pure
**orchestrator** chooses the next command from the current state and event. The **Driver** runs
that command, records its event before changing state, and repeats. A run can stop as DONE,
FAILED, or ABORTED. The run log supports inspection and resume. Stuck detection and budgets stop
runs that cannot make progress.

Read [reliability](reference.md#reliability), [stuck detection](reference.md#stuck-detection), and
[inspecting past runs](reference.md#inspecting-past-runs). Follow
[`src/orchestrator/stuck.ts`](../src/orchestrator/stuck.ts),
[`src/driver/driver.ts`](../src/driver/driver.ts), and
[`src/runlog/file-runlog.ts`](../src/runlog/file-runlog.ts).

## Choose your next depth

- To use goaly, open the [CLI cookbook](reference.md#cli-cookbook).
- To inspect evidence, use the [verification guide](verification.md).
- To change code, read [ARCHITECTURE.md](../ARCHITECTURE.md), [CONTEXT.md](../CONTEXT.md), and
  [AGENTS.md](../AGENTS.md) in that order.
