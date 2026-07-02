import type { RunId } from '../domain/ids';
import type { RunResult } from '../cli/run-cmd';
import type { UiGates } from './ui-gates';
import type { RootRef } from './api-schema';

/** The stable key of a root ("one live run per root" is enforced on this). */
export function rootKey(root: RootRef): string {
  return root.kind === 'main' ? 'main' : `worktree:${root.name}`;
}

/** One UI-owned, in-process run (ADR 0015). Everything durable stays on disk; this is only wiring. */
export type UiRunSession = {
  readonly runId: RunId;
  readonly root: RootRef;
  readonly startedAt: number;
  readonly gates: UiGates;
  /** Cooperative stop: flips the interrupted probe AND rejects any parked gate. */
  readonly stop: () => void;
  readonly stopRequested: () => boolean;
  /** Settles when `executeRun` returns (the run is then no longer live). */
  readonly done: Promise<RunResult>;
};

/**
 * Server-memory registry of UI-owned runs. Enforces ONE live run per root: per-run locks stop two
 * drivers on one run directory, but nothing else stops two agents editing one working tree — the
 * refusal (mapped to 409) tells the operator to start the second run in a worktree instead.
 * Sessions are removed when `done` settles; the disk (write-ahead log) remains the source of truth
 * for everything the UI renders about them.
 */
export class SessionStore {
  readonly #byRunId = new Map<string, UiRunSession>();

  /** Register a session, refusing a second live run in the same root (fail-closed). */
  register(session: UiRunSession): void {
    const clash = this.liveInRoot(session.root);
    if (clash !== undefined) {
      throw new RootBusyError(session.root, clash.runId);
    }
    this.#byRunId.set(session.runId, session);
    void session.done.finally(() => {
      // The session's job ends with the run; history is served from the log like any other run.
      this.#byRunId.delete(session.runId);
    });
  }

  get(runId: string): UiRunSession | undefined {
    return this.#byRunId.get(runId);
  }

  /** The live UI-owned session in this root, if any. */
  liveInRoot(root: RootRef): UiRunSession | undefined {
    const key = rootKey(root);
    for (const session of this.#byRunId.values()) {
      if (rootKey(session.root) === key) return session;
    }
    return undefined;
  }

  all(): UiRunSession[] {
    return [...this.#byRunId.values()];
  }

  /** Stop every live session (server shutdown) — each run stays resumable via its log. */
  stopAll(): void {
    for (const session of this.#byRunId.values()) session.stop();
  }
}

/** Thrown by {@link SessionStore.register} — the HTTP layer maps it to 409. */
export class RootBusyError extends Error {
  constructor(root: RootRef, runId: string) {
    const where = root.kind === 'main' ? 'the main workspace' : `worktree '${root.name}'`;
    super(
      `a run (${runId}) is already active in ${where} — wait for it, stop it, ` +
        `or start the new run in a worktree`,
    );
    this.name = 'RootBusyError';
  }
}
