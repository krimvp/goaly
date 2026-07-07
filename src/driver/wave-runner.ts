import { randomUUID } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { CompiledContract } from '../domain/contract';
import type { TokenUsage } from '../domain/usage';
import { asRunId, type DiffHash, type RunId } from '../domain/ids';
import type { Workspace, Worktree, WorktreeHost } from '../workspace/workspace';
import { DeterministicVerifier } from '../verify/deterministic';
import type { Logger } from '../log/logger';
import { noopLogger } from '../log/logger';
import { drive, type DriverDeps } from './driver';
import type { WavePhaseSpec, WaveOutcome, WaveResult, WaveRunner } from './wave';

/**
 * Compose the FULL driver dependencies for one wave CHILD, rooted at its worktree. The composition
 * root provides the real thing (harness/ladder/approver/runlog scoped to the worktree — see
 * `makeWaveRunner` in compose.ts); tests inject fakes so the whole wave runs with zero LLM and zero
 * subprocesses. `runId` names the child's OWN write-ahead log dir; `interrupted` is the parent's
 * cooperative stop probe. Contract for implementers: the child's `budget` MUST be the PARENT's
 * meter (the wave shares the run's one budget) and `interrupted` should be threaded through so
 * Ctrl-C stops children cleanly between steps.
 */
export type ComposeChild = (
  spec: WavePhaseSpec,
  worktree: Worktree,
  runId: RunId,
  interrupted?: () => boolean,
) => Promise<DriverDeps>;

/** A child after the sequential preparation stage (worktree + deps), before its concurrent run. */
type Prepared = {
  readonly spec: WavePhaseSpec;
  readonly worktree: Worktree | null;
  readonly deps: DriverDeps | null;
  readonly runId: RunId | null;
  readonly reason: string | null;
};

/** What one finished child contributes to the merge stage. */
type ChildResult = {
  readonly spec: WavePhaseSpec;
  readonly worktree: Worktree | null;
  /** Set only when the child reached DONE (both keys) — the merge candidates. */
  readonly done: {
    readonly tree: DiffHash;
    readonly contract: CompiledContract | null;
  } | null;
  readonly reason: string | null;
  readonly usage: TokenUsage | undefined;
};

/**
 * EXPERIMENTAL — the real cooperative-wave executor (`--parallel-phases`). One `run()`:
 *
 *  1. **Fork.** Checkpoint the canonical tree (the merge BASE) and give each phase an isolated
 *     worktree + a full CHILD goaly run (`drive()` — its own frozen contract, iterations, two-key
 *     gate, and write-ahead log inside the worktree), all children concurrent on the SHARED budget.
 *  2. **Merge.** In phase order, 3-way merge each DONE child's tree onto the accumulated result
 *     (`mergeTrees(base, acc, child)`), copying the child's compiler-authored verification files
 *     across (they are git-excluded, so no tree snapshot carries them). A textual conflict marks
 *     that child `unmerged` — nothing of it is applied.
 *  3. **Promote + re-verify.** Promote the merged tree into the canonical workspace, then re-run
 *     each merged child's frozen DETERMINISTIC rungs against the combined tree — clean merges can
 *     still break each other semantically, and a merge is NEVER trusted. A red re-verify marks that
 *     child `unmerged` (its sub-goal re-runs sequentially on this very tree, so nothing is lost and
 *     nothing is greened). Judge rungs are not re-run here: each child already turned both keys in
 *     isolation, and the run's final ACCEPTANCE contract still gates the whole (two keys, LLM
 *     included) — the merged-tree guard is the ungameable deterministic bar in between.
 *  4. **Checkpoint.** Snapshot the final canonical tree — the `WAVE_RAN.tree` baseline.
 *
 * Every failure shape degrades to `unmerged` (the classic sequential phase), never a throw out of
 * `run()` for a per-child problem; the Driver additionally catches a wholesale throw and downgrades
 * the entire wave.
 */
export class DefaultWaveRunner implements WaveRunner {
  readonly #host: WorktreeHost;
  readonly #workspace: Workspace;
  readonly #workspaceRoot: string;
  readonly #composeChild: ComposeChild;
  readonly #verifyTimeoutMs: number | undefined;
  readonly #log: Logger;

  constructor(opts: {
    host: WorktreeHost;
    /** The CANONICAL workspace (fork point, promotion target, and re-verify scope). */
    workspace: Workspace;
    /** The canonical workspace's filesystem root (authored-file copy target). */
    workspaceRoot: string;
    composeChild: ComposeChild;
    /** Per-rung kill timeout for the post-merge deterministic re-verify (the run's verify cap). */
    verifyTimeoutMs?: number;
    logger?: Logger;
  }) {
    this.#host = opts.host;
    this.#workspace = opts.workspace;
    this.#workspaceRoot = opts.workspaceRoot;
    this.#composeChild = opts.composeChild;
    this.#verifyTimeoutMs = opts.verifyTimeoutMs;
    this.#log = opts.logger ?? noopLogger;
  }

  async run(phases: readonly WavePhaseSpec[], interrupted?: () => boolean): Promise<WaveResult> {
    const base = await this.#workspace.checkpoint();
    this.#log.info('wave: forking children', {
      phases: phases.map((p) => p.index).join(','),
      base,
    });

    // Worktree creation is SEQUENTIAL (concurrent `git worktree add` calls contend on repo locks);
    // only the child RUNS are concurrent. A preparation failure is already a fail-closed result.
    const prepared: Prepared[] = [];
    for (const spec of phases) prepared.push(await this.#prepareChild(spec, base, interrupted));
    const children = await Promise.all(prepared.map((p) => this.#driveChild(p)));
    try {
      const { merged, outcomes, tree } = await this.#mergeAndReverify(base, children);
      this.#log.info('wave: merged + re-verified', {
        merged: merged.length,
        total: children.length,
        tree,
      });
      return { outcomes, tree };
    } finally {
      for (const child of children) {
        if (child.worktree !== null) await this.#host.removeWorktree(child.worktree);
      }
    }
  }

  /** Create ONE child's worktree + deps (sequential stage). Never throws — a failure is a reason. */
  async #prepareChild(
    spec: WavePhaseSpec,
    base: DiffHash,
    interrupted?: () => boolean,
  ): Promise<Prepared> {
    // The worktree handle survives a later failure so the teardown sweep still removes it.
    let worktree: Worktree | null = null;
    try {
      worktree = await this.#host.addWorktree(base);
      const runId = asRunId(`run-wave-p${spec.index}-${randomUUID()}`);
      const deps = await this.#composeChild(spec, worktree, runId, interrupted);
      return { spec, worktree, deps, runId, reason: null };
    } catch (e) {
      return {
        spec,
        worktree,
        deps: null,
        runId: null,
        reason: `child failed to start: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /** Drive ONE prepared child to a terminal outcome (concurrent stage). Never throws. */
  async #driveChild(prepared: Prepared): Promise<ChildResult> {
    const { spec, worktree, deps, runId } = prepared;
    if (worktree === null || deps === null || runId === null) {
      return { spec, worktree, done: null, reason: prepared.reason ?? 'child not prepared', usage: undefined };
    }
    try {
      this.#log.info('wave child starting', { phase: spec.index, runId, root: worktree.root });
      const outcome = await drive(deps, spec.config, runId);
      const usage = outcome.usage?.total;
      if (outcome.status !== 'DONE') {
        return {
          spec,
          worktree,
          done: null,
          reason: `child run ${outcome.status}${outcome.reason !== undefined ? `: ${outcome.reason}` : ''}`,
          usage,
        };
      }
      // The child's frozen contract (for the post-merge re-verify + authored-file copy) comes from
      // ITS OWN write-ahead log. Fail-closed: no recoverable contract ⇒ unmerged — never an
      // unverified merge.
      const contract = await lastContract(deps);
      if (contract === null) {
        return { spec, worktree, done: null, reason: 'child log carried no frozen contract', usage };
      }
      const tree = await worktree.scope.diffHash();
      return { spec, worktree, done: { tree, contract }, reason: null, usage };
    } catch (e) {
      return {
        spec,
        worktree,
        done: null,
        reason: `child failed to run: ${e instanceof Error ? e.message : String(e)}`,
        usage: undefined,
      };
    }
  }

  /** Stages 2–4: sequential merge (+ authored-file copy), promote, deterministic re-verify, checkpoint. */
  async #mergeAndReverify(
    base: DiffHash,
    children: readonly ChildResult[],
  ): Promise<{ merged: ChildResult[]; outcomes: WaveOutcome[]; tree: DiffHash }> {
    const ordered = [...children].sort((a, b) => a.spec.index - b.spec.index);
    const outcomes: WaveOutcome[] = [];
    const merged: ChildResult[] = [];
    let acc: string = base;

    for (const child of ordered) {
      const { index } = child.spec;
      const usage = child.usage !== undefined ? { usage: child.usage } : {};
      if (child.done === null) {
        outcomes.push({ kind: 'unmerged', index, reason: child.reason ?? 'child did not finish', ...usage });
        continue;
      }
      try {
        const m = await this.#host.mergeTrees(base, acc, child.done.tree);
        if (m.kind === 'conflict') {
          this.#log.warn('wave: merge conflict — phase downgrades to sequential', {
            phase: index,
            detail: m.detail,
          });
          outcomes.push({ kind: 'unmerged', index, reason: `merge conflict: ${m.detail}`, ...usage });
          continue;
        }
        acc = m.tree;
        merged.push(child);
      } catch (e) {
        outcomes.push({
          kind: 'unmerged',
          index,
          reason: `merge failed: ${e instanceof Error ? e.message : String(e)}`,
          ...usage,
        });
      }
    }

    if (merged.length > 0) {
      await this.#host.promoteTree(acc);
      // Authored verification files are git-excluded (never in a tree snapshot) — carry them over
      // from each merged child's worktree so its frozen commands still have their inputs.
      for (const child of merged) await this.#copyGeneratedFiles(child);
    }

    // Re-verify each merged child's frozen deterministic rungs against the COMBINED tree.
    for (const child of merged) {
      const verdict = await this.#reverify(child);
      const usage = child.usage !== undefined ? { usage: child.usage } : {};
      if (verdict === null) {
        outcomes.push({ kind: 'merged', index: child.spec.index, ...usage });
      } else {
        this.#log.warn('wave: post-merge re-verify red — phase downgrades to sequential', {
          phase: child.spec.index,
          detail: verdict,
        });
        outcomes.push({
          kind: 'unmerged',
          index: child.spec.index,
          reason: `post-merge re-verify failed: ${verdict}`,
          ...usage,
        });
      }
    }

    const tree = await this.#workspace.checkpoint();
    outcomes.sort((a, b) => a.index - b.index);
    return { merged, outcomes, tree };
  }

  /** Run the child's frozen DETERMINISTIC rungs on the canonical tree; null = green, else the red detail. */
  async #reverify(child: ChildResult): Promise<string | null> {
    const contract = child.done?.contract;
    if (contract === undefined || contract === null) return 'no frozen contract to re-verify';
    for (const rung of contract.rungs) {
      if (rung.kind !== 'deterministic') continue;
      const verifier = new DeterministicVerifier(rung.command, rung.label, this.#verifyTimeoutMs);
      const verdict = await verifier.verify(this.#workspace, contract.goal, contract.rubric);
      if (!verdict.pass) return verdict.detail;
    }
    return null;
  }

  /** Copy a merged child's compiler-authored (git-excluded) verification files into the canonical root. */
  async #copyGeneratedFiles(child: ChildResult): Promise<void> {
    const contract = child.done?.contract;
    const worktree = child.worktree;
    if (contract === undefined || contract === null || worktree === null) return;
    const canonicalRoot = resolve(this.#workspaceRoot);
    for (const file of contract.generatedFiles) {
      // Containment: the paths were validated at compile, but re-check before writing (fail-closed).
      const src = resolve(worktree.root, file.path);
      const dst = resolve(canonicalRoot, file.path);
      if (!src.startsWith(resolve(worktree.root) + sep) || !dst.startsWith(canonicalRoot + sep)) {
        throw new Error(`generated file escapes the workspace: ${file.path}`);
      }
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
  }
}

/** The LAST frozen contract in a child's write-ahead log (revisions re-freeze; the last one ran). */
async function lastContract(deps: DriverDeps): Promise<CompiledContract | null> {
  try {
    const stored = await deps.runlog.read();
    if (stored === null) return null;
    let contract: CompiledContract | null = null;
    for (const entry of stored.entries) {
      if (entry.event.tag === 'CONTRACT_COMPILED') contract = entry.event.contract;
    }
    return contract;
  } catch {
    return null;
  }
}

/** Re-export the seam types so the composition root imports one module. */
export type { WavePhaseSpec, WaveOutcome, WaveResult, WaveRunner };
