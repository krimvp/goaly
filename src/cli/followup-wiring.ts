import path from 'node:path';
import { RESUMED_GOAL_PLACEHOLDER, type ParsedArgs } from './args';
import {
  planRecontract,
  recontractCommand,
  recontractSeedFromProvenance,
} from '../followup/recontract';
import { compactRun } from '../followup/compaction';
import { readRun } from '../runlog/inspect';
import { STATE_DIR } from './compose';
import { asRunId } from '../domain/ids';
import type { RunConfig } from '../domain/config';
import type { RunFollowup, RunLogHeader, RunProvenance } from '../runlog/runlog';

/**
 * FOLLOW-UP WIRING (Capability C `--from-run`, and its `--recontract` variant, issue #117): the
 * compile-phase authoring seed, resolved once at the composition edge.
 *
 * Split out of `run-cmd.ts` because the seed has TWO sources — a fresh `--from-run` invocation, and
 * a RESUME that has to rebuild it from the run-log header — and both must agree on what a follow-up
 * carries. Keeping them side by side is what makes the second one hard to forget.
 */

/**
 * Resolve the follow-up wiring (Capability C, `--from-run`). Returns the run config (possibly with an
 * inherited session seed) and the prior-run compaction to feed the compiler, or a fail-closed exit
 * code after writing a clear message. A normal run (no `--from-run`) passes through unchanged.
 * Exported for tests: this is where the header's follow-up record is built, and it must carry the
 * SAME seed the compiler is handed.
 */
export type FollowupResolution =
  | {
      readonly ok: true;
      readonly config: RunConfig;
      readonly followupSeed: string | undefined;
      /** Set only for a `--recontract` successor (issue #117): recorded in the new run's header. */
      readonly provenance?: RunProvenance;
      /**
       * Set only for an ORDINARY `--from-run` follow-up: recorded in the new run's header so a
       * resume that still has to compile can rebuild the seed (see {@link resumeAuthoringSeed}).
       */
      readonly followup?: RunFollowup;
    }
  | { readonly ok: false; readonly code: number };

export async function resolveFollowup(
  parsed: ParsedArgs,
  warn: (s: string) => void,
): Promise<FollowupResolution> {
  if (parsed.fromRunId === undefined) {
    // --inherit-session / --recontract are meaningless without --from-run; fail closed rather than
    // silently ignore. A re-contract in particular MUST name the run whose defect it repairs.
    if (parsed.inheritSession) {
      warn('goaly: --inherit-session requires --from-run <runId>\n');
      return { ok: false, code: 2 };
    }
    if (parsed.recontract !== undefined) {
      warn('goaly: --recontract requires --from-run <runId> (the run whose contract was adjudicated defective)\n');
      return { ok: false, code: 2 };
    }
    return { ok: true, config: parsed.config, followupSeed: undefined };
  }
  if (parsed.resumeRunId !== undefined) {
    warn('goaly: --from-run starts a NEW run and cannot be combined with --resume\n');
    return { ok: false, code: 2 };
  }

  const stateDir = path.join(parsed.workspace, STATE_DIR);
  const prior = await readRun(stateDir, parsed.fromRunId);
  if (prior === null) {
    warn(`goaly: --from-run ${parsed.fromRunId}: no such run in ${stateDir}\n`);
    return { ok: false, code: 2 };
  }
  if (!prior.ok) {
    warn(`goaly: --from-run ${parsed.fromRunId}: run log is corrupt: ${prior.error}\n`);
    return { ok: false, code: 2 };
  }
  const followupSeed = compactRun(prior.detail);

  // Session inheritance (opt-in). Cross-harness is invalid (session ids are harness-specific) → hard
  // error; a no-op under --phased; a prior run with no recoverable session degrades to fresh (the
  // compaction still applies). Otherwise seed the new config so the first turn resumes the prior session.
  let config = parsed.config;
  if (parsed.inheritSession) {
    if (parsed.config.phased) {
      warn('goaly: --inherit-session is ignored under --phased (using fresh session + compaction)\n');
    } else if (prior.detail.harness !== undefined && prior.detail.harness !== parsed.harness) {
      warn(
        `goaly: --inherit-session needs the same harness as the prior run ` +
          `(prior=${prior.detail.harness}, now=${parsed.harness}); session ids are harness-specific\n`,
      );
      return { ok: false, code: 2 };
    } else if (prior.detail.sessionId === undefined) {
      warn(
        'goaly: --inherit-session: the prior run recorded no resumable session — ' +
          'starting fresh (the compaction still applies)\n',
      );
    } else {
      config = { ...parsed.config, seedSessionId: prior.detail.sessionId };
    }
  }

  // `--recontract` (issue #117): a SUCCESSOR run for a bar goaly's OWN adjudicator condemned. The
  // generic follow-up compaction is replaced by the defect-report repair brief, the goal is inherited
  // from the predecessor's FROZEN contract (a repair changes the bar, not the goal), and the chain is
  // bounded by the depth carried in the predecessor's header. Everything else — Seal, the freeze, the
  // two keys, the pre-flight negative control — is an ordinary run.
  if (parsed.recontract !== undefined) {
    const decision = planRecontract(prior.detail, {
      maxRecontracts: parsed.recontract.maxRecontracts,
    });
    if (!decision.ok) {
      warn(`goaly: --recontract: ${decision.reason}\n`);
      return { ok: false, code: 2 };
    }
    const { goal, seed, provenance } = decision.plan;
    if (config.goal !== RESUMED_GOAL_PLACEHOLDER && config.goal !== goal) {
      warn(
        `goaly: --recontract re-authors the bar for the PREDECESSOR's frozen goal; the goal passed on ` +
          `this command line is ignored (use --from-run without --recontract to change the goal)\n`,
      );
    }
    return { ok: true, config: { ...config, goal }, followupSeed: seed, provenance };
  }
  return {
    ok: true,
    config,
    followupSeed,
    followup: { predecessorRunId: asRunId(parsed.fromRunId), seed: followupSeed },
  };
}

/**
 * Rebuild the compile-phase authoring seed for a `--resume` from the run-log HEADER.
 *
 * `--from-run` is refused with `--resume`, so on a resume the seed can never arrive from the command
 * line. It only matters when this resume still has to COMPILE (a crash before `CONTRACT_COMPILED`
 * was persisted, or a Seal "revise" round); past the freeze nothing re-authors and the seed is inert
 * (see `src/followup/seeded.ts`). Without it such a recompile authored a fresh bar with the prior
 * run — or the adjudicated defect — out of view: the successor quietly degrading into an ordinary
 * authoring pass over the kept tree.
 *
 * Returns `undefined` for an ordinary run, and for a follow-up/successor whose header predates the
 * recorded seed — WARNING in that case rather than degrading in silence.
 */
export function resumeAuthoringSeed(
  header: RunLogHeader,
  goal: string,
  warn: (s: string) => void,
): string | undefined {
  // Ordinary follow-up (`--from-run`): the bounded prior-run compaction, recorded verbatim.
  const followup = header.followup;
  if (followup !== undefined) {
    if (followup.seed !== undefined) return followup.seed;
    warn(
      `goaly: --resume: this run is a follow-up of ${followup.predecessorRunId}, but its log ` +
        `predates the recorded compaction — a re-compile on this resume would re-author the bar ` +
        `without the prior-run context. Prefer a fresh: ` +
        `goaly "<goal>" --from-run ${followup.predecessorRunId}\n`,
    );
    return undefined;
  }
  // Re-contract successor (issue #117): the REPAIR BRIEF, rebuilt from the header's provenance.
  const provenance = header.provenance;
  if (provenance === undefined) return undefined;
  const rebuilt = recontractSeedFromProvenance(goal, provenance);
  if (rebuilt !== undefined) return rebuilt;
  warn(
    `goaly: --resume: this run is a --recontract successor of ${provenance.predecessorRunId}, ` +
      `but its log predates the recorded predecessor bar — a re-compile on this resume would ` +
      `re-author the bar without the repair brief. Prefer a fresh: ` +
      `${recontractCommand(provenance.predecessorRunId)}\n`,
  );
  return undefined;
}
