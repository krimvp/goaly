import { join } from 'node:path';
import { parseArgs, type ParsedArgs } from '../cli/args';
import { executeRun, type RunResult } from '../cli/run-cmd';
import { STATE_DIR } from '../cli/compose';
import type { Logger } from '../log/logger';
import { anyRunLockActive } from '../runlog/lock';
import { readRun } from '../runlog/inspect';
import { asRunId } from '../domain/ids';
import type { SealDecision } from '../domain/verdict';
import { WorktreeManager, WorktreeError, type WorktreeInfo } from '../workspace/worktree-manager';
import { enumerateRoots } from './roots';
import { SessionStore, RootBusyError, type UiRunSession } from './sessions';
import { UiGates } from './ui-gates';
import type { GateDecision, PendingGate, ResumeRequest, RootRef, StartRunRequest } from './api-schema';

/**
 * The interactive actions behind the goaly-ui POST routes (ADR 0015). UI-owned runs execute
 * IN-PROCESS through the same `executeRun` the CLI uses — same guards, same run lock, same
 * write-ahead log — with the browser gates, a per-run stop probe, and a forced stream transcript
 * injected. Crash-safety is the log's: a dead server leaves every run resumable.
 */
export type StartOutcome =
  | { ok: true; runId: string }
  | { ok: false; status: number; error: string };

export type UiActions = {
  start(req: StartRunRequest): Promise<StartOutcome>;
  resume(runId: string, req: ResumeRequest): Promise<StartOutcome>;
  /** Cooperative stop of a UI-owned live run. False = unknown / not UI-owned. */
  stop(runId: string): boolean;
  /** The parked gate of a UI-owned run; null = the run is not UI-owned (or not live). */
  pendingGate(runId: string): PendingGate | undefined | null;
  resolveGate(runId: string, gateId: string, decision: GateDecision): 'ok' | 'no-session' | 'stale';
  /** Subscribe to a UI-owned run's gate lifecycle (the SSE push). Null = not UI-owned. */
  onGateEvent(
    runId: string,
    listener: (event: PendingGate | { resolved: string }) => void,
  ): (() => void) | null;
  createWorktree(name: string, base?: string): Promise<WorktreeInfo>;
  removeWorktree(name: string, opts: { force: boolean; deleteBranch: boolean }): Promise<void>;
  /** Stop every live UI-owned run (server shutdown). */
  shutdown(): void;
};

export function makeUiActions(opts: {
  workspaceRoot: string;
  sessions?: SessionStore;
  logger?: Logger;
  /** Injected run executor (tests). Default: the real shared CLI run path. */
  execute?: typeof executeRun;
}): UiActions {
  const sessions = opts.sessions ?? new SessionStore();
  const execute = opts.execute ?? executeRun;
  const manager = new WorktreeManager({ root: opts.workspaceRoot });

  async function launch(
    argv: string[],
    root: RootRef,
    rootPath: string,
    opts2: { worktreeName?: string; gatesEnabled: boolean },
  ): Promise<StartOutcome> {
    // One live run per root: refuse while ANY live process (UI-owned or a terminal's) drives a run
    // in this tree — two agents editing one working tree is never safe (fail-closed, 409).
    const uiClash = sessions.liveInRoot(root);
    if (uiClash !== undefined) {
      return { ok: false, status: 409, error: new RootBusyError(root, uiClash.runId).message };
    }
    if (await anyRunLockActive(join(rootPath, STATE_DIR))) {
      return {
        ok: false,
        status: 409,
        error:
          `a live run is already active in ${root.kind === 'main' ? 'the main workspace' : `worktree '${root.kind === 'worktree' ? root.name : ''}'`} — ` +
          `wait for it, stop it, or start the new run in a worktree`,
      };
    }

    let parsed: ParsedArgs;
    try {
      parsed = await parseArgs(argv);
    } catch (e) {
      return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
    }
    if (opts2.worktreeName !== undefined) parsed = { ...parsed, worktreeRun: opts2.worktreeName };

    const gates = new UiGates();
    let stopRequested = false;
    const errors: string[] = [];
    let started: ((runId: string) => void) | undefined;
    const startedPromise = new Promise<string>((resolve) => {
      started = resolve;
    });

    const done: Promise<RunResult> = execute(parsed, {
      out: (s) => opts.logger?.debug('ui run output', { text: s.trim() }),
      err: (s) => {
        errors.push(s);
        opts.logger?.debug('ui run stderr', { text: s.trim() });
      },
      // The browser gates apply ONLY to a non-autonomous run: an autonomous one keeps the classic
      // AutoSealGate (auto-accept, loud-logged, invariant #5) — injecting a parking gate there
      // would hang the run on a modal nobody asked for.
      ...(opts2.gatesEnabled ? { sealGate: gates, planGate: gates } : {}),
      interrupted: () => stopRequested,
      onStarted: (runId) => started?.(runId),
      forceStreamTranscript: true,
      quietConsole: true,
    }).catch((e: unknown) => {
      // executeRun is designed not to reject; if it ever does, fail the session closed.
      errors.push(e instanceof Error ? e.message : String(e));
      return { code: 1, runId: undefined, outcome: undefined };
    });

    // The 201 races the failure path: onStarted fires once the run lock is held; a guard failure
    // (bad flag, missing run, locked) settles `done` first with the collected error text.
    const raced = await Promise.race([
      startedPromise.then((runId) => ({ kind: 'started' as const, runId })),
      done.then((result) => ({ kind: 'done' as const, result })),
    ]);
    if (raced.kind === 'done') {
      const error = errors.join('').trim() || `run refused to start (exit ${raced.result.code})`;
      return { ok: false, status: 422, error };
    }

    const session: UiRunSession = {
      runId: asRunId(raced.runId),
      root,
      startedAt: Date.now(),
      gates,
      stop: () => {
        stopRequested = true;
        gates.stop();
      },
      stopRequested: () => stopRequested,
      done,
    };
    try {
      sessions.register(session);
    } catch (e) {
      // A race lost to a concurrent start: stop the just-started run and refuse (fail-closed).
      session.stop();
      if (e instanceof RootBusyError) return { ok: false, status: 409, error: e.message };
      throw e;
    }
    return { ok: true, runId: raced.runId };
  }

  return {
    async start(req: StartRunRequest): Promise<StartOutcome> {
      let root: RootRef = { kind: 'main' };
      let rootPath = opts.workspaceRoot;
      let worktreeName: string | undefined;
      if (req.worktree !== undefined) {
        try {
          const info = await manager.ensure(req.worktree.name, req.worktree.base);
          root = { kind: 'worktree', name: req.worktree.name };
          rootPath = info.path;
          worktreeName = req.worktree.name;
        } catch (e) {
          if (e instanceof WorktreeError) return { ok: false, status: 422, error: e.message };
          throw e;
        }
      }
      const argv = startArgv(req, rootPath);
      return launch(argv, root, rootPath, {
        ...(worktreeName !== undefined ? { worktreeName } : {}),
        gatesEnabled: !req.autonomous,
      });
    },

    async resume(runId: string, req: ResumeRequest): Promise<StartOutcome> {
      // Find which root holds the run (main or a worktree) — resume composes against THAT tree.
      const roots = await enumerateRoots(opts.workspaceRoot, () => manager.list());
      for (const candidate of roots) {
        const found = await readRun(candidate.stateDir, runId);
        if (found === null) continue;
        if (!found.ok) return { ok: false, status: 409, error: `run ${runId} is corrupt: ${found.error}` };
        const worktreeName = candidate.ref.kind === 'worktree' ? candidate.ref.name : undefined;
        const argv = resumeArgv(runId, req, candidate.path, found.detail.harness);
        // Gates stay enabled on resume: a run interrupted AT a Seal re-requests it, and it must
        // park in the browser (a stdin prompt inside the server would hang). A run past its Seal
        // never consults the gate again (the fold replays the logged decision).
        return launch(argv, candidate.ref, candidate.path, {
          ...(worktreeName !== undefined ? { worktreeName } : {}),
          gatesEnabled: true,
        });
      }
      return { ok: false, status: 404, error: `no such run: ${runId}` };
    },

    stop(runId: string): boolean {
      const session = sessions.get(runId);
      if (session === undefined) return false;
      session.stop();
      return true;
    },

    pendingGate(runId: string): PendingGate | undefined | null {
      const session = sessions.get(runId);
      if (session === undefined) return null;
      return session.gates.pending();
    },

    resolveGate(runId: string, gateId: string, decision: GateDecision): 'ok' | 'no-session' | 'stale' {
      const session = sessions.get(runId);
      if (session === undefined) return 'no-session';
      return session.gates.resolve(gateId, toSealDecision(decision)) ? 'ok' : 'stale';
    },

    onGateEvent(runId, listener): (() => void) | null {
      const session = sessions.get(runId);
      if (session === undefined) return null;
      return session.gates.onGateEvent(listener);
    },

    createWorktree: (name, base) => manager.create(name, base),
    removeWorktree: async (name, o) => {
      await manager.remove(name, o);
    },

    shutdown: () => sessions.stopAll(),
  };
}

function toSealDecision(decision: GateDecision): SealDecision {
  if (decision.decision === 'approve') return { kind: 'approve' };
  if (decision.decision === 'revise') return { kind: 'revise', feedback: decision.feedback };
  return { kind: 'reject', reason: 'rejected from goaly ui' };
}

/**
 * Build the run's argv from the validated request — the run then goes through `parseArgs` +
 * `executeRun` EXACTLY like a terminal invocation (same defaults, same .goalyrc overlay, same
 * validation), so the UI path can never drift from the CLI. `--flag=value` form throughout: a
 * value can then never be mistaken for a flag.
 */
export function startArgv(req: StartRunRequest, workspacePath: string): string[] {
  const argv = ['run', `--goal=${req.goal}`, `--workspace=${workspacePath}`];
  if (req.verifyCmd !== undefined) argv.push(`--verify-cmd=${req.verifyCmd}`);
  if (req.generate === true) argv.push('--generate');
  if (req.intent !== undefined) argv.push(`--intent=${req.intent}`);
  if (req.rubric !== undefined) argv.push(`--rubric=${req.rubric}`);
  if (req.harness !== undefined) argv.push(`--harness=${req.harness}`);
  if (req.autonomous) argv.push('--autonomous');
  if (req.phased === true) argv.push('--phased');
  if (req.maxIterations !== undefined) argv.push(`--max-iterations=${req.maxIterations}`);
  if (req.budgetTokens !== undefined) argv.push(`--budget-tokens=${req.budgetTokens}`);
  if (req.model !== undefined) argv.push(`--model=${req.model}`);
  return argv;
}

/** The resume argv: `--resume` + only the extension flags the request carries (ADR 0012). */
export function resumeArgv(
  runId: string,
  req: ResumeRequest,
  workspacePath: string,
  harness: string | undefined,
): string[] {
  // The goal/verify placeholders satisfy the CLI's parse only — a resume ALWAYS continues with the
  // LOG's effective config (header + logged extensions), never this invocation's re-parsed one.
  const argv = [
    'run',
    `--resume=${runId}`,
    `--workspace=${workspacePath}`,
    '--goal=(resume)',
    '--verify-cmd=true',
    '--autonomous',
  ];
  // The recorded harness keeps the resume faithful (the config fold re-reads the log's effective
  // config either way; the flag matters for preflight + the outcome hints).
  if (harness !== undefined) argv.push(`--harness=${harness}`);
  if (req.note !== undefined) argv.push(`--note=${req.note}`);
  if (req.maxIterations !== undefined) argv.push(`--max-iterations=${req.maxIterations}`);
  if (req.budgetTokens !== undefined) argv.push(`--budget-tokens=${req.budgetTokens}`);
  if (req.budgetWallMs !== undefined) argv.push(`--budget-wall-ms=${req.budgetWallMs}`);
  if (req.stuckNoDiff !== undefined) argv.push(`--stuck-no-diff=${req.stuckNoDiff}`);
  return argv;
}
