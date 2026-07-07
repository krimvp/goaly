import type { RunConfig } from '../domain/config';
import type { OrchestratorEvent } from '../domain/events';
import type { DiffHash } from '../domain/ids';

/**
 * EXPERIMENTAL — the cooperative parallel-wave seam (`--parallel-phases`). The Driver performs a
 * `RUN_WAVE` command through this interface and feeds the reducer ONE `WAVE_RAN` event; everything
 * concurrent, git-shaped, or LLM-adjacent lives behind it (invariant #1). The real implementation
 * (`src/cli/wave-runner.ts`) runs each phase as its own frozen, two-key CHILD goaly run in an
 * isolated worktree, merges the DONE children in phase order, and RE-VERIFIES each merged phase's
 * frozen ladder on the combined tree; tests inject fakes. Like every seam it must not reject in
 * normal operation — per-child failures become `unmerged` outcomes (the fail-closed sequential
 * downgrade); the Driver additionally catches a thrown runner and downgrades the WHOLE wave.
 */

/** One wave member: the plan phase index + the phase config the reducer derived for it. */
export type WavePhaseSpec = { readonly index: number; readonly config: RunConfig };

/** Per-phase wave outcome — exactly the shape persisted in the `WAVE_RAN` event. */
export type WaveOutcome = Extract<OrchestratorEvent, { tag: 'WAVE_RAN' }>['outcomes'][number];

/** The whole wave's result: one outcome per member + the post-merge checkpoint tree. */
export type WaveResult = {
  readonly outcomes: WaveOutcome[];
  /** The post-merge checkpoint tree (the diff baseline for the phases that follow). */
  readonly tree: DiffHash;
};

export interface WaveRunner {
  /**
   * Run the wave. `interrupted` is the parent run's cooperative stop probe (Ctrl-C/SIGTERM) —
   * threaded into every child's deps so children stop cleanly between steps like the parent does.
   */
  run(phases: readonly WavePhaseSpec[], interrupted?: () => boolean): Promise<WaveResult>;
}
