import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunConfig } from '../domain/config';
import type { LlmProvider } from '../llm/provider';
import type { Logger } from '../log/logger';
import type { Planner } from '../plan/planner';
import type { VerifierCompiler } from '../compile/compiler';
import { ContractDryRunCompiler } from '../compile/contract-dry-run';
import { CritiquedCompiler } from '../compile/critiqued-compiler';
import { CritiquedPlanner } from '../plan/critiqued-planner';
import { SeededCompiler, SeededPlanner } from '../followup/seeded';
import { realExec, type ExecFn } from '../workspace/git-workspace';
import { FsScratchHost } from '../workspace/scratch-copy';
import type { WorkspaceFacts } from '../workspace/workspace-facts';

/**
 * The AUTHORING-side decorator stack: everything that wraps the compiler or the planner between the
 * composition root and the raw LLM-backed authoring step. Each is identity when its feature is off,
 * so a default run composes exactly what it did before the decorator existed.
 *
 * Extracted from `compose.ts` so the composition root stays about wiring seams together, not about
 * the policy of which pre-Seal guard applies to which contract.
 */

/** Wrap the compiler with the follow-up seed (Capability C) when present; identity otherwise. */
export function seedCompiler(inner: VerifierCompiler, seed: string | undefined): VerifierCompiler {
  return seed !== undefined ? new SeededCompiler(inner, seed) : inner;
}

/**
 * Wrap the compiler with the pre-Seal contract critics; identity when none apply. Two INDEPENDENT
 * switches share this decorator and its one bounded re-author loop: the opt-in `--adversarial`
 * red-team panel, and the default-ON FALSE-RED satisfiability critic (issue #118; `--generate`
 * only). Wraps the INNER compiler so the seed still reaches attempt 1; critics meter as `'compile'`.
 */
export function critiqueCompiler(
  inner: VerifierCompiler,
  config: RunConfig,
  makeLlm: () => LlmProvider,
  workspaceRoot: string,
  logger: Logger,
  facts: WorkspaceFacts | undefined,
): VerifierCompiler {
  const adv = config.adversarial;
  const critics = adv.enabled ? adv.contractCritics : 0;
  const satisfiability = adv.satisfiabilityCritic && config.verifier.kind === 'generate';
  if (adv.contractCritiqueRounds <= 0 || (critics <= 0 && !satisfiability)) return inner;
  return new CritiquedCompiler({
    inner,
    llm: makeLlm(),
    critics, satisfiability,
    rounds: adv.contractCritiqueRounds,
    readFile: (rel) => readFile(path.join(workspaceRoot, rel), 'utf8'),
    logger, ...(facts !== undefined ? { facts: facts.summary } : {}),
  });
}

/**
 * Wrap the compiler with the COMPILE-TIME POSITIVE CONTROL (`--contract-dry-run`, issue #115);
 * identity when off or on the `--verify-cmd` path. It sits OUTSIDE the critics so the contract that
 * gets executed is the one the critics already accepted, and INSIDE the follow-up seed so a seeded
 * first attempt is still controlled. The reference implementation it authors runs only in a
 * throwaway {@link FsScratchHost} copy rooted at the workspace, never in the workspace itself.
 * Spend meters as `'compile'` — it is part of authoring the bar.
 *
 * SANDBOX (invariant #4): the scratch runs the contract's `setup` and every deterministic rung —
 * the SAME untrusted commands as the verifier seam, over a tree that now also holds LLM-authored
 * code. So it takes the composed `runLauncher` and runs them under the same jail and network policy
 * (`--sandbox`/`--sandbox-net`). The parameter is REQUIRED (pass `undefined` only for the identity
 * `--sandbox none` launcher) so this wiring cannot be dropped by omission: a run that refuses to
 * start rather than go unsandboxed must not execute anything bare on the host here either.
 */
export function dryRunCompiler(
  inner: VerifierCompiler,
  config: RunConfig,
  makeLlm: () => LlmProvider,
  workspaceRoot: string,
  verifyTimeoutMs: number | undefined,
  logger: Logger,
  facts: WorkspaceFacts | undefined,
  runLauncher: ((exec: ExecFn) => ExecFn) | undefined,
): VerifierCompiler {
  if (!config.adversarial.contractDryRun || config.verifier.kind !== 'generate') return inner;
  return new ContractDryRunCompiler({
    inner,
    llm: makeLlm(),
    scratch: new FsScratchHost(
      workspaceRoot,
      runLauncher !== undefined ? { exec: runLauncher(realExec) } : {},
    ),
    ...(verifyTimeoutMs !== undefined ? { timeoutMs: verifyTimeoutMs } : {}),
    readFile: (rel) => readFile(path.join(workspaceRoot, rel), 'utf8'),
    logger, ...(facts !== undefined ? { facts: facts.summary } : {}),
  });
}

/** Wrap the planner with the follow-up seed (Capability C) when present; identity otherwise. */
export function seedPlanner(inner: Planner, seed: string | undefined): Planner {
  return seed !== undefined ? new SeededPlanner(inner, seed) : inner;
}

/**
 * Wrap the planner with the `--adversarial` plan critique when enabled; identity otherwise. Only
 * the LLM AgentPlanner is ever passed here — a `--plan-file` StaticPlanner is the user's explicit
 * plan and is never critiqued (the caller routes around this wrapper). Critic spend meters under
 * the `'plan'` phase — critique is part of authoring the plan, not a new spend category.
 */
export function critiquePlanner(
  inner: Planner,
  config: RunConfig,
  makeLlm: () => LlmProvider,
  logger: Logger,
): Planner {
  const adv = config.adversarial;
  if (!adv.enabled || adv.planCritics <= 0 || adv.planCritiqueRounds <= 0) return inner;
  return new CritiquedPlanner({
    inner,
    llm: makeLlm(),
    critics: adv.planCritics,
    rounds: adv.planCritiqueRounds,
    logger,
  });
}
