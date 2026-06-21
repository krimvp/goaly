import type { Command, OrchestratorEvent, RunOutcome } from '../domain/events';
import { OrchestratorEvent as OrchestratorEventSchema } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { ContractHash, RunId } from '../domain/ids';
import { DiffHash, coerceSessionId } from '../domain/ids';
import type { Verdict } from '../domain/verdict';
import { isTerminal, iterationCount, type OrchestratorState } from '../orchestrator/state';
import { initial, step } from '../orchestrator/step';
import { replay } from '../runlog/replay';
import type { VerifierCompiler } from '../compile/compiler';
import type { ContractGate } from '../compile/gateA';
import type { HarnessAdapter } from '../harness/adapter';
import type { Verifier } from '../verify/verifier';
import type { Approver } from '../verify/approver';
import type { Workspace } from '../workspace/workspace';
import type { Clock } from './clock';
import type { BudgetMeter } from './budget';
import type { RunLog } from '../runlog/runlog';
import { noopLogger, type Logger } from '../log/logger';
import { errorMessage } from '../util/errors';

/** Distinct sentinel tree hashes used when the workspace cannot be hashed (kept != each other
 * so a workspace-error iteration never spuriously trips the no-diff detector). */
const SENTINEL_PREV_HASH: DiffHash = DiffHash.parse('0000000');
const SENTINEL_POST_HASH: DiffHash = DiffHash.parse('0000001');

/**
 * Everything the Driver needs to perform effects. The ladder is built once from the frozen
 * contract via `makeLadder` (the composition root knows how to assemble deterministic +
 * judge rungs); the Driver treats it as an opaque Verifier.
 */
export type DriverDeps = {
  compiler: VerifierCompiler;
  gateA: ContractGate;
  harness: HarnessAdapter;
  makeLadder: (contract: CompiledContract) => Verifier;
  approver: Approver;
  workspace: Workspace;
  clock: Clock;
  budget: BudgetMeter;
  runlog: RunLog;
  /**
   * Diagnostic logger (the Driver is the orchestration choke-point: it sees every Command, Event,
   * verdict and decision). Optional and defaults to a no-op so logging never affects control flow,
   * never touches the filesystem in tests, and is pure wiring — it has no bearing on the contract,
   * the run log, or replay.
   */
  logger?: Logger;
};

export type DriveOptions = {
  /** Resume from an existing run log instead of starting fresh. */
  resume?: boolean;
};

/**
 * The Driver: performs the Commands the pure reducer requests, feeds the resulting Events
 * back, and persists every event write-ahead. The ONLY component that touches the clock,
 * the budget, processes, or the filesystem.
 */
export async function drive(
  deps: DriverDeps,
  config: RunConfig,
  runId: RunId,
  options: DriveOptions = {},
): Promise<RunOutcome> {
  let state: OrchestratorState;
  let commands: Command[];
  let seq: number;
  let ladder: Verifier | null = null;
  let contractHash: ContractHash | null = null;
  const log = deps.logger ?? noopLogger;

  log.info(options.resume === true ? 'resuming run' : 'starting run', {
    runId,
    resume: options.resume === true,
  });

  if (options.resume === true) {
    const resumed = await resume(deps, config);
    state = resumed.state;
    commands = resumed.commands;
    seq = resumed.seq;
    contractHash = resumed.contractHash;
    if (resumed.contract !== null) ladder = deps.makeLadder(resumed.contract);
  } else {
    [state, commands] = initial(config);
    seq = 0;
    await deps.runlog.writeHeader({ runId, startedAt: deps.clock.now(), config });
  }

  try {
    while (!isTerminal(state)) {
      if (commands.length !== 1) {
        throw new Error(
          `driver invariant: non-terminal state ${state.tag} emitted ${commands.length} commands (expected 1)`,
        );
      }
      const command = commands[0]!;
      log.debug('perform command', { command: command.tag, state: state.tag });

      // Perform the effect (the only place anything stochastic/IO happens), then build the
      // Event. `ladder` is created at COMPILE and reused for every RUN_VERIFIER.
      const performed = await perform(command, deps, ladder);
      const event = OrchestratorEventSchema.parse(performed.event); // parse at the reducer's edge
      if (performed.ladder !== undefined) ladder = performed.ladder;
      if (event.tag === 'CONTRACT_COMPILED') contractHash = event.contract.contractHash;
      logEvent(log, command, event);

      // step() is pure — computing it before persisting is side-effect-free and lets us log the
      // resulting state tag in the same write-ahead entry. Durability is AT-LEAST-ONCE: a crash
      // after `perform` but before this `append` re-runs exactly that one effect on resume (the
      // harness's session resume makes RUN_AGENT idempotent); we accept one repeated effect over
      // a lost one.
      const [next, nextCommands] = step(state, event);
      seq += 1;
      await deps.runlog.append({
        runId,
        seq,
        ts: deps.clock.now(),
        contractHash,
        event,
        stateTagAfter: next.tag,
      });

      log.debug('transition', { from: state.tag, to: next.tag, seq });
      state = next;
      commands = nextCommands;
    }
  } catch (e) {
    // Last-resort safety net: every effectful seam is individually fail-closed, but an unexpected
    // throw (corrupt log on append, invalid transition) must still resolve to a terminal outcome
    // rather than reject — so the caller always gets a RunOutcome.
    log.error('driver error (fail-closed → ABORTED)', { reason: errorMessage(e) });
    return {
      status: 'ABORTED',
      reason: `driver error: ${errorMessage(e)}`,
      iterations: iterationCount(state),
      contractHash: contractHash ?? null,
      runId,
    };
  }

  const outcome = buildOutcome(state, runId);
  log.info('run finished', { status: outcome.status, iterations: outcome.iterations });
  return outcome;
}

/**
 * Translate a performed Event into leveled diagnostics. Content that may carry repo text or
 * secrets (prompts, harness output, verifier detail, the diff) is kept at `debug` only — `info`
 * stays content-free (statuses, counts, hashes, decisions).
 */
function logEvent(log: Logger, command: Command, event: OrchestratorEvent): void {
  switch (event.tag) {
    case 'CONTRACT_COMPILED':
      log.info('contract compiled', {
        contractHash: event.contract.contractHash,
        rungs: event.contract.rungs.length,
      });
      return;
    case 'COMPILE_FAILED':
      log.error('compile failed', { reason: event.reason });
      return;
    case 'GATE_A_DECIDED':
      log.info('gate A decided', { decision: event.decision.kind });
      return;
    case 'AGENT_RAN':
      log.info('agent ran', {
        status: event.run.status,
        changed: event.prevDiffHash !== event.diffHash,
        ...(event.budget.tokensSpent !== undefined ? { tokensSpent: event.budget.tokensSpent } : {}),
        budgetExceeded: event.budget.exceeded,
      });
      if (command.tag === 'RUN_AGENT') {
        // Prompt CONTENT stays out of logs; its size is a safe diagnostic signal.
        log.debug('agent prompt', { promptChars: command.prompt.length });
      }
      return;
    case 'VERIFIED':
      log.info('verified', { pass: event.verdict.pass, confidence: event.verdict.confidence });
      log.debug('verdict detail', { detail: event.verdict.detail });
      return;
    case 'GATE_B_DECIDED':
      log.info('gate B decided', {
        veto: event.approval.veto,
        ...(event.approval.reason !== undefined ? { reason: event.approval.reason } : {}),
      });
      return;
  }
}

type Performed = { event: OrchestratorEvent; ladder?: Verifier };

async function perform(
  command: Command,
  deps: DriverDeps,
  ladder: Verifier | null,
): Promise<Performed> {
  switch (command.tag) {
    case 'COMPILE_VERIFIER': {
      try {
        const contract = await deps.compiler.compile(command.config, command.feedback);
        return { event: { tag: 'CONTRACT_COMPILED', contract }, ladder: deps.makeLadder(contract) };
      } catch (e) {
        return { event: { tag: 'COMPILE_FAILED', reason: errorMessage(e) } };
      }
    }

    case 'REQUEST_GATE_A': {
      const decision = await deps.gateA.approveContract(command.contract);
      return { event: { tag: 'GATE_A_DECIDED', decision } };
    }

    case 'RUN_AGENT': {
      try {
        const prevDiffHash = await deps.workspace.diffHash();
        const run = await deps.harness.run(command.prompt, command.sessionId);
        deps.budget.record(run.tokensUsed);
        const diffHash = await deps.workspace.diffHash();
        const budget = deps.budget.snapshot();
        return { event: { tag: 'AGENT_RAN', run, prevDiffHash, diffHash, budget } };
      } catch (e) {
        // Fail-closed: a workspace (diffHash) failure must not crash the loop. Synthesize a
        // crashed run with DISTINCT sentinel hashes (so no-diff doesn't false-fire) and a valid,
        // persistable AGENT_RAN event; the frozen verifier then runs and the loop proceeds toward
        // a clean ABORTED/FAILED rather than an unhandled rejection.
        const budget = deps.budget.snapshot();
        return {
          event: {
            tag: 'AGENT_RAN',
            run: {
              output: `workspace error: ${errorMessage(e)}`,
              sessionId: command.sessionId ?? coerceSessionId(undefined, 'workspace-error'),
              status: 'crashed',
            },
            prevDiffHash: SENTINEL_PREV_HASH,
            diffHash: SENTINEL_POST_HASH,
            budget,
          },
        };
      }
    }

    case 'RUN_VERIFIER': {
      const active = ladder ?? deps.makeLadder(command.contract);
      const verdict = await runVerifierFailClosed(
        active,
        deps.workspace,
        command.contract.goal,
        command.contract.rubric,
      );
      return { event: { tag: 'VERIFIED', verdict } };
    }

    case 'REQUEST_GATE_B': {
      let diff = '';
      try {
        diff = await deps.workspace.diff();
        const approval = await deps.approver.review({
          goal: command.goal,
          rubric: command.rubric,
          diff,
          verdicts: command.verdicts,
        });
        return { event: { tag: 'GATE_B_DECIDED', approval } };
      } catch (e) {
        // Fail-closed: an approver that errors is treated as a veto, never a green.
        return {
          event: { tag: 'GATE_B_DECIDED', approval: { veto: true, reason: `approver error: ${errorMessage(e)}` } },
        };
      }
    }
  }
}

/** A verifier that throws is a malformed grader; treat it as a hard fail, never a green. */
async function runVerifierFailClosed(
  verifier: Verifier,
  workspace: Workspace,
  goal: string,
  rubric: string,
): Promise<Verdict> {
  try {
    return await verifier.verify(workspace, goal, rubric);
  } catch (e) {
    return { pass: false, confidence: 1, detail: `verifier error (fail-closed): ${errorMessage(e)}` };
  }
}

// ---- resume / replay ------------------------------------------------------

type Resumed = {
  state: OrchestratorState;
  commands: Command[];
  seq: number;
  contractHash: ContractHash | null;
  contract: CompiledContract | null;
};

/**
 * Reconstruct state by folding the pure reducer over the persisted event stream, then
 * continue. No completed iteration is repeated — replay applies `step` only, never `perform`.
 */
async function resume(deps: DriverDeps, config: RunConfig): Promise<Resumed> {
  const stored = await deps.runlog.read();
  if (stored === null) {
    const [state, commands] = initial(config);
    return { state, commands, seq: 0, contractHash: null, contract: null };
  }

  // Same replay-fold the read-only `runs` inspection uses — a single source of truth so an
  // inspected run's state matches exactly what resume reconstructs here.
  const { state, commands, contract, contractHash } = replay(stored.header.config, stored.entries);
  return { state, commands, seq: stored.entries.length, contractHash, contract };
}

function buildOutcome(state: OrchestratorState, runId: RunId): RunOutcome {
  switch (state.tag) {
    case 'DONE':
      return {
        status: 'DONE',
        iterations: state.iterations,
        contractHash: state.contractHash,
        runId,
      };
    case 'FAILED':
      return {
        status: 'FAILED',
        reason: state.reason,
        iterations: state.iterations,
        contractHash: state.contractHash ?? null,
        runId,
      };
    case 'ABORTED':
      return {
        status: 'ABORTED',
        reason: state.reason,
        iterations: state.iterations,
        contractHash: state.contractHash ?? null,
        runId,
      };
    default:
      throw new Error(`buildOutcome called on non-terminal state ${state.tag}`);
  }
}
