import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ParsedArgs } from './args';
import { composeDeps, STATE_DIR, EndpointConfigError } from './compose';
import { SandboxUnavailableError, isAllowlist, startEgressProxy, type EgressProxy } from '../sandbox';
import { drive } from '../driver/driver';
import { asRunId, type RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';
import type { SealGate } from '../compile/seal';
import type { PlanGate } from '../plan/plan-gate';
import type { PhasedStreamSink } from '../agent-cli/stream';
import { acquireRunLock, RunLockedError, type RunLock } from '../runlog/lock';
import { resumeHint } from './resume-cmd';
import { computeCost } from './cost';
import { makeInterruptController } from './crash-guard';
import { prepareRun } from './run-prepare';
import { logStartupDiagnostics } from './run-banner';
import { composeOptions, resolveRunDegraded } from './run-wiring';
import { formatOutcome } from './run-report';

// The run path's public text/wiring helpers keep their historical import site.
export { makeInterruptController } from './crash-guard';
export { adjudicatedResumeWarning, formatOutcome, nextStepHint } from './run-report';

/**
 * The SHARED run entrypoint (ADR 0015): the whole `goaly run` path — cost table, guards,
 * follow-up/resume resolution, run lock, egress proxy, composition, `drive()`, and the outcome
 * report — behind injectable IO, so the CLI (`main`) and the goaly-ui server execute the SAME
 * code and can never drift. `main()` passes real stdout/stderr and signal handlers; the UI server
 * passes its browser gates, a per-run stop probe, and a stream sink.
 */
export type RunIo = {
  out: (s: string) => void;
  err: (s: string) => void;
  /**
   * Inject the Seal / plan-Seal gates (the goaly-ui browser gates, or fakes). A gate
   * IMPLEMENTATION — the freeze and the loud SEAL_DECIDED log are unchanged (invariant #5).
   * Absent ⇒ the classic selection on `config.autonomous` (human prompt vs auto-accept).
   */
  sealGate?: SealGate;
  planGate?: PlanGate;
  /**
   * External cooperative-stop probe (the UI's stop button). Polled by the Driver between steps —
   * flipping it yields the same clean, resumable ABORTED as Ctrl-C. When injected, NO process
   * signal handlers are installed (the embedding process owns its signals).
   */
  interrupted?: () => boolean;
  /** Subscribe to the run's phase-tagged stream events (the UI's live push channel). */
  onStreamEvent?: PhasedStreamSink;
  /** Fires as soon as the run id is known (before the loop) — the UI's 201 response hook. */
  onStarted?: (runId: RunId) => void;
  /** Force the durable stream transcript on (UI-owned runs record one so history survives). */
  forceStreamTranscript?: boolean;
  /** Keep the diagnostics logger off the console (the UI server's terminal stays quiet). */
  quietConsole?: boolean;
};

export type RunResult = { code: number; runId: RunId | undefined; outcome: RunOutcome | undefined };

/** Exit code for a run stopped by Ctrl-C/SIGTERM (128 + SIGINT), distinct from FAILED/ABORTED (1). */
const EXIT_INTERRUPTED = 130;

/**
 * Execute one run end-to-end. Byte-for-byte the historical `main()` run path — extracted so the
 * goaly-ui server drives runs through the very same guards, lock, composition, and reporting.
 * The read-only head (guards, resume resolution, preflight, `--dry-run`) is `prepareRun`; from
 * the run lock on, everything here MUTATES.
 */
export async function executeRun(parsed: ParsedArgs, io: RunIo): Promise<RunResult> {
  const startedAt = Date.now();
  const worktreeName = typeof parsed.worktreeRun === 'string' ? parsed.worktreeRun : undefined;

  const prep = await prepareRun(parsed, io);
  if (!prep.ok) return { code: prep.code, runId: undefined, outcome: undefined };
  parsed = prep.parsed;
  const { runConfig, followup, autoPinnedBaseline, followupSeed } = prep;

  const resuming = parsed.resumeRunId !== undefined;
  const runId: RunId =
    parsed.resumeRunId !== undefined ? asRunId(parsed.resumeRunId) : asRunId(`run-${randomUUID()}`);

  // Exclusive per-run lock: two goaly processes appending to one run log would interleave duplicate
  // seq values and corrupt it logically. A crashed holder self-heals (stale-pid detection); a LIVE
  // holder refuses to start with a clear message (fail-closed, invariant #4).
  let runLock: RunLock;
  try {
    runLock = await acquireRunLock(path.join(parsed.workspace, STATE_DIR, runId), {
      onStaleReclaim: (message) => io.err(`goaly: ${message}\n`),
    });
  } catch (e) {
    if (e instanceof RunLockedError) {
      io.err(`goaly: ${e.message}\n`);
      return { code: 2, runId, outcome: undefined };
    }
    throw e;
  }
  io.onStarted?.(runId);

  // Start the egress proxy (issue #39) when the sandbox policy uses an allowlist. It's IO (a running
  // server), so it lives at the composition EDGE — started here, threaded into both jailed seams,
  // and ALWAYS torn down in the `finally` below (even if the run throws). Absent ⇒ no allowlist.
  let egressProxy: EgressProxy | undefined;
  const egressAllowlist = isAllowlist(parsed.sandbox.network)
    ? parsed.sandbox.network.allowlist
    : undefined;
  if (egressAllowlist !== undefined) {
    egressProxy = await startEgressProxy(egressAllowlist);
  }
  try {
    let deps;
    try {
      deps = composeDeps(
        runConfig,
        composeOptions(parsed, io, {
          runId,
          concreteWorkspaceMode: prep.concreteWorkspaceMode,
          autoPinnedBaseline,
          followupSeed,
          egressProxy,
        }),
      );
    } catch (e) {
      // Fail-closed (invariant #4): a requested sandbox mechanism that the host lacks REFUSES TO
      // START — a clear message and a non-zero exit, never a silent unsandboxed run.
      if (e instanceof SandboxUnavailableError) {
        io.err(`goaly: ${e.message}\n`);
        return { code: 2, runId, outcome: undefined };
      }
      // Fail-closed config error for `--harness goaly-code` / `--llm-provider openai` (missing base URL or
      // model): a clear message + non-zero exit, never a silent run pointing at nothing.
      if (e instanceof EndpointConfigError) {
        io.err(`goaly: ${e.message}\n`);
        return { code: 2, runId, outcome: undefined };
      }
      throw e;
    }

    const { resolvedModels, degraded } = resolveRunDegraded(parsed, runConfig, prep.recordedDegraded);
    logStartupDiagnostics(deps.logger, {
      parsed,
      runId,
      worktreeName,
      egressAllowlist,
      runConfig,
      resolvedModels,
      degraded,
      autoPinnedBaseline,
      resuming,
    });

    // Cooperative stop: an injected probe (the UI's stop button) is used as-is — the embedding
    // process owns its signals. Otherwise install the classic Ctrl-C controller around drive().
    const interrupt =
      io.interrupted !== undefined
        ? { interrupted: io.interrupted, onSignal: undefined }
        : makeInterruptController(runId, io.err);

    let outcome;
    try {
      if (interrupt.onSignal !== undefined) {
        process.on('SIGINT', interrupt.onSignal);
        process.on('SIGTERM', interrupt.onSignal);
      }
      outcome = await drive(
        { ...deps, interrupted: interrupt.interrupted },
        runConfig,
        runId,
        {
          resume: resuming,
          harness: parsed.harness,
          ...(degraded !== undefined ? { degraded } : {}),
          ...(parsed.resumeExtend !== undefined ? { extend: parsed.resumeExtend } : {}),
          ...(followup.provenance !== undefined ? { provenance: followup.provenance } : {}),
          ...(followup.followup !== undefined ? { followup: followup.followup } : {}),
        },
      );
    } finally {
      if (interrupt.onSignal !== undefined) {
        process.removeListener('SIGINT', interrupt.onSignal);
        process.removeListener('SIGTERM', interrupt.onSignal);
      }
    }

    // Surface the egress audit trail: any denied host:port the jail tried to reach (issue #39).
    if (egressProxy !== undefined && egressProxy.denied.length > 0) {
      deps.logger?.warn('sandbox egress denied', {
        count: egressProxy.denied.length,
        sample: [...new Set(egressProxy.denied)].slice(0, 8).join(', '),
      });
    }

    const cost =
      prep.priceTable !== undefined && outcome.usage !== undefined
        ? computeCost(outcome.usage, resolvedModels, prep.priceTable)
        : undefined;
    // Capability A: append "Continue this session:" with the harness-correct interactive-resume
    // command (or the goaly-code → --from-run route). Stays quiet when there is no real session.
    const hint = resumeHint(parsed.harness, outcome.sessionId, runId);
    io.out(`${formatOutcome(outcome, cost, hint, degraded, Date.now() - startedAt)}\n`);
    if (outcome.status === 'DONE') return { code: 0, runId, outcome };
    return { code: interrupt.interrupted() ? EXIT_INTERRUPTED : 1, runId, outcome };
  } finally {
    await egressProxy?.close();
    await runLock.release();
  }
}
