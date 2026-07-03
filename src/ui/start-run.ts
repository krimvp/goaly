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
import { LandingManager, type WorktreeChanges, type MergeOpts, type OpenPrOpts } from '../workspace/landing';
import { makeLlmProvider } from '../cli/compose';
import type { LlmProvider } from '../llm/provider';
import type { LlmProviderChoice } from '../cli/args';
import { draftPr as draftPrFromDiff } from '../llm/pr-draft';
import { readWorkspaceFile, writeVerificationFile } from '../workspace/workspace-files';
import { sha256Hex } from '../util/hash';
import type { CompiledContract } from '../domain/contract';
import { enumerateRoots } from './roots';
import { SessionStore, RootBusyError, type UiRunSession } from './sessions';
import { UiGates } from './ui-gates';
import type {
  GateDecision,
  GateFileWrite,
  GateFilesResponse,
  PendingGate,
  PrDraftRequest,
  ResumeRequest,
  RootRef,
  StartRunRequest,
  WorkspacePrRequest,
} from './api-schema';

/**
 * The interactive actions behind the goaly-ui POST routes (ADR 0015). UI-owned runs execute
 * IN-PROCESS through the same `executeRun` the CLI uses — same guards, same run lock, same
 * write-ahead log — with the browser gates, a per-run stop probe, and a forced stream transcript
 * injected. Crash-safety is the log's: a dead server leaves every run resumable.
 */
export type StartOutcome =
  | { ok: true; runId: string }
  | { ok: false; status: number; error: string };

/** `resolveGate` outcomes beyond success — each maps to a distinct HTTP status in the router. */
export type ResolveGateResult =
  | 'ok'
  | 'no-session'
  | 'stale'
  /** An `edited` decision against a parked plan gate (manual editing is contract-only). */
  | 'invalid'
  /** Approve refused: authored files changed on disk AFTER the freeze — re-freeze first. */
  | { drifted: string[] };

export type UiActions = {
  start(req: StartRunRequest): Promise<StartOutcome>;
  resume(runId: string, req: ResumeRequest): Promise<StartOutcome>;
  /** Cooperative stop of a UI-owned live run. False = unknown / not UI-owned. */
  stop(runId: string): boolean;
  /** The parked gate of a UI-owned run; null = the run is not UI-owned (or not live). */
  pendingGate(runId: string): PendingGate | undefined | null;
  resolveGate(runId: string, gateId: string, decision: GateDecision): Promise<ResolveGateResult>;
  /** Subscribe to a UI-owned run's gate lifecycle (the SSE push). Null = not UI-owned. */
  onGateEvent(
    runId: string,
    listener: (event: PendingGate | { resolved: string }) => void,
  ): (() => void) | null;
  /**
   * The review station's artifact contents (ADR 0016): one entry per generated file the PARKED
   * seal contract pins, read from the session's checkout.
   */
  gateFiles(runId: string, gateId: string): Promise<GateFilesResponse | 'no-session' | 'stale' | 'invalid'>;
  /**
   * Save one in-UI file edit. The path must be STRICTLY one of the parked contract's
   * generatedFiles paths (allowlist before the traversal guard). Never refreezes by itself.
   */
  writeGateFile(
    runId: string,
    gateId: string,
    write: GateFileWrite,
  ): Promise<{ written: string; sha256: string } | 'no-session' | 'stale' | 'invalid' | 'bad-path'>;
  createWorktree(name: string, base?: string): Promise<WorktreeInfo>;
  removeWorktree(name: string, opts: { force: boolean; deleteBranch: boolean }): Promise<void>;
  /** The read-only landing change set of a worktree (ADR 0017). */
  worktreeChanges(name: string): Promise<WorktreeChanges>;
  /** Commit a worktree's changes onto its branch (post-run landing). */
  commitWorktree(name: string, message: string): Promise<{ head: string }>;
  /** Merge a worktree's branch back into the main workspace (post-run landing). */
  mergeWorktree(name: string, opts: MergeOpts): Promise<{ merged: string; head: string }>;
  /** Open a PR for a worktree's branch (commit-if-dirty → push → `gh pr create`). */
  openPr(name: string, opts: OpenPrOpts): Promise<{ url: string }>;
  /** Draft a PR title + body from the worktree diff via the LLM ("the agent fills in the MR"). */
  draftPr(name: string, req: PrDraftRequest): Promise<{ title: string; body: string }>;
  /** The read-only landing change set of the MAIN workspace (a run made without --worktree). */
  workspaceChanges(): Promise<WorktreeChanges>;
  /** Commit the main workspace's changes onto its current branch. */
  commitWorkspace(message: string): Promise<{ head: string }>;
  /** Eject the main workspace's changes onto goaly/<name>, push, and open a PR (then return home). */
  openPrFromMain(req: WorkspacePrRequest): Promise<{ url: string; branch: string }>;
  /** Draft a PR title + body from the MAIN workspace diff via the LLM. */
  draftPrWorkspace(req: PrDraftRequest): Promise<{ title: string; body: string }>;
  /** Stop every live UI-owned run (server shutdown). */
  shutdown(): void;
};

/** Map a run's harness to the LLM provider that drafts its PR — non-CLI harnesses fall back to claude. */
function draftProviderChoice(harness: string | undefined): LlmProviderChoice {
  return harness === 'codex' || harness === 'droid' || harness === 'pi' || harness === 'claude'
    ? harness
    : 'claude';
}

/** Wall-clock cap on the PR-draft completion, so a hung agent CLI never wedges the request. */
const DRAFT_TIMEOUT_MS = 120_000;

/** The landing surface `makeUiActions` delegates to — injectable so tests need no `gh`/remote. */
export type LandingActions = Pick<
  LandingManager,
  'changes' | 'commit' | 'merge' | 'openPr' | 'changesMain' | 'commitMain' | 'openPrFromMain'
>;

export function makeUiActions(opts: {
  workspaceRoot: string;
  sessions?: SessionStore;
  logger?: Logger;
  /** Injected run executor (tests). Default: the real shared CLI run path. */
  execute?: typeof executeRun;
  /** Injected landing surface (tests). Default: the real LandingManager over the workspace. */
  landing?: LandingActions;
  /** Injected LLM factory for PR drafting (tests). Default: the run-harness-backed provider. */
  llmFor?: (harness: string | undefined) => LlmProvider;
}): UiActions {
  const sessions = opts.sessions ?? new SessionStore();
  const execute = opts.execute ?? executeRun;
  const manager = new WorktreeManager({ root: opts.workspaceRoot });
  const landing = opts.landing ?? new LandingManager({ root: opts.workspaceRoot });
  const llmFor =
    opts.llmFor ??
    ((harness: string | undefined): LlmProvider =>
      makeLlmProvider(draftProviderChoice(harness), undefined, { timeoutMs: DRAFT_TIMEOUT_MS }));

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
      rootPath,
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

    async resolveGate(runId: string, gateId: string, decision: GateDecision): Promise<ResolveGateResult> {
      const session = sessions.get(runId);
      if (session === undefined) return 'no-session';
      // Approve-time drift check (ADR 0016, UX only — the GeneratedFilesGuard would red a drifted
      // file at iteration 1 anyway): refuse to approve a SEAL contract whose authored files no
      // longer match their frozen pins, so a stale approval never wastes an agent turn. The gate
      // stays parked; the operator re-freezes ('edited') and reviews the actual content first.
      if (decision.decision === 'approve') {
        const pending = session.gates.pending();
        if (pending !== undefined && pending.gateId === gateId && pending.kind === 'seal') {
          const drifted: string[] = [];
          for (const file of pending.contract.generatedFiles) {
            const content = await readWorkspaceFile(session.rootPath, file.path);
            if (content === null || sha256Hex(content) !== file.sha256) drifted.push(file.path);
          }
          if (drifted.length > 0) return { drifted };
        }
      }
      return session.gates.resolve(gateId, toSealDecision(decision));
    },

    onGateEvent(runId, listener): (() => void) | null {
      const session = sessions.get(runId);
      if (session === undefined) return null;
      return session.gates.onGateEvent(listener);
    },

    async gateFiles(runId, gateId) {
      const pending = pendingSealGate(sessions, runId, gateId);
      if (typeof pending === 'string') return pending;
      const { session, contract } = pending;
      const files = await Promise.all(
        contract.generatedFiles.map(async (file) => {
          const content = await readWorkspaceFile(session.rootPath, file.path);
          const sha256OnDisk = content === null ? null : sha256Hex(content);
          const truncated = content !== null && content.length > MAX_GATE_FILE_CHARS;
          return {
            path: file.path,
            frozenSha256: file.sha256,
            sha256OnDisk,
            content: content === null ? null : truncated ? content.slice(0, MAX_GATE_FILE_CHARS) : content,
            truncated,
            dirty: sha256OnDisk !== file.sha256,
          };
        }),
      );
      return { gateId, files };
    },

    async writeGateFile(runId, gateId, write) {
      const pending = pendingSealGate(sessions, runId, gateId);
      if (typeof pending === 'string') return pending;
      const { session, contract } = pending;
      // Allowlist BEFORE the traversal guard: only the exact paths the parked contract pins are
      // writable through this route — the review station edits the authored bar, nothing else.
      if (!contract.generatedFiles.some((f) => f.path === write.path)) return 'bad-path';
      await writeVerificationFile(session.rootPath, write.path, write.content, opts.logger ?? noopUiLogger);
      return { written: write.path, sha256: sha256Hex(write.content) };
    },

    createWorktree: (name, base) => manager.create(name, base),
    removeWorktree: async (name, o) => {
      await manager.remove(name, o);
    },

    worktreeChanges: (name) => landing.changes(name),
    commitWorktree: (name, message) => landing.commit(name, message),
    mergeWorktree: (name, o) => landing.merge(name, o),
    openPr: (name, o) => landing.openPr(name, o),
    async draftPr(name, req) {
      // Read the (untrusted) diff off the worktree, then let the run's harness draft the title+body.
      const { diff, files } = await landing.changes(name);
      return draftPrFromDiff(llmFor(req.harness), { ...(req.goal !== undefined ? { goal: req.goal } : {}), files, diff });
    },

    workspaceChanges: () => landing.changesMain(),
    commitWorkspace: (message) => landing.commitMain(message),
    openPrFromMain: (req) => landing.openPrFromMain(req),
    async draftPrWorkspace(req) {
      const { diff, files } = await landing.changesMain();
      return draftPrFromDiff(llmFor(req.harness), { ...(req.goal !== undefined ? { goal: req.goal } : {}), files, diff });
    },

    shutdown: () => sessions.stopAll(),
  };
}

function toSealDecision(decision: GateDecision): SealDecision {
  switch (decision.decision) {
    case 'approve':
      return { kind: 'approve' };
    case 'revise':
      return { kind: 'revise', feedback: decision.feedback };
    case 'edited':
      return {
        kind: 'edited',
        ...(decision.patch !== undefined ? { patch: decision.patch } : {}),
      };
    case 'reject':
      return { kind: 'reject', reason: 'rejected from goaly ui' };
  }
}

/** Cap on the content served per gate file (dirtiness is still computed from the FULL hash). */
const MAX_GATE_FILE_CHARS = 100_000;

/** Resolve the parked SEAL gate for the file routes: typed misses for the router's status map. */
function pendingSealGate(
  sessions: SessionStore,
  runId: string,
  gateId: string,
):
  | { session: UiRunSession; contract: CompiledContract }
  | 'no-session'
  | 'stale'
  | 'invalid' {
  const session = sessions.get(runId);
  if (session === undefined) return 'no-session';
  const pending = session.gates.pending();
  if (pending === undefined || pending.gateId !== gateId) return 'stale';
  if (pending.kind !== 'seal') return 'invalid';
  return { session, contract: pending.contract };
}

/** The gate-file writer logs through the ui logger when present; otherwise stays silent. */
const noopUiLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopUiLogger,
};

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
