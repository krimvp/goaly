import type { ContractInput } from '../domain/config';
import type { CompiledContract, Rung } from '../domain/contract';
import { criticalFindings, renderCritiqueFeedback } from '../domain/critique';
import { runCriticPanel } from '../llm/critic-panel';
import type { LlmProvider } from '../llm/provider';
import { noopLogger, type Logger } from '../log/logger';
import { UNTRUSTED_SYSTEM_CLAUSE, wrapUntrusted } from '../verify/prompt-safety';
import type { VerifierCompiler } from './compiler';

const SYSTEM_PROMPT =
  'You are a red-teamer attacking a verification contract BEFORE it is sealed and frozen for an ' +
  'automated goal loop. Assume the worker that must satisfy it is lazy and adversarial: your only ' +
  'job is to find how it could GAME this bar or how the bar could fail to evaluate. Look for: a ' +
  'verify command that passes vacuously or without exercising the goal; a rubric that diverges ' +
  'from what the command actually measures; authored test files with tautological or empty ' +
  'assertions, or expected outputs a worker could hard-code against; a bar satisfiable by a ' +
  'parallel reimplementation that never uses the artifact the goal is about; missing required ' +
  'tools that will make the bar unevaluable; a setup or verify command that needs the network at ' +
  'verify time. Mark a finding "critical" ONLY if the worker could green this bar without ' +
  'genuinely meeting the goal, or the bar cannot be evaluated at all — style nits are "minor". ' +
  'Respond with ONLY a single JSON object, no prose, no markdown fences, matching exactly: ' +
  '{ "verdict": "pass" | "revise", "findings": Array<{ "severity": "critical" | "minor", ' +
  '"lens"?: string, "claim": string, "fix"?: string }> }. A "revise" verdict MUST carry at least ' +
  'one finding. ' +
  UNTRUSTED_SYSTEM_CLAUSE;

/** The red-team lens taxonomy, cycled across the contract-critic panel. */
export const CONTRACT_REDTEAM_LENSES: readonly string[] = [
  'GAMING/VACUITY — could a lazy worker make this command exit 0 (and this rubric read as met) ' +
    'without genuinely achieving the goal? Does the command actually exercise the goal at all?',
  'RUBRIC-COMMAND-MISMATCH — does the rubric promise something the command never measures (or vice ' +
    'versa), leaving a gap a worker can slip through?',
  'TAMPER/HARD-CODE SURFACE — do the authored verification files contain expected outputs or fixed ' +
    'inputs a worker could special-case, or assertions weak enough to satisfy with a stub?',
  'REPRODUCIBILITY — will this bar evaluate offline and deterministically: are all required tools ' +
    'declared, does nothing fetch the network at verify time, is the outcome stable across re-runs? ' +
    'And will each authored file even LOAD in this workspace: check mechanically that its module ' +
    'format matches the workspace facts (e.g. require() in an ES-module Node package crashes at ' +
    'load), that its imports/paths resolve to files that will exist, and that the command actually ' +
    'invokes the files as authored.',
];

export type CritiquedCompilerOpts = {
  inner: VerifierCompiler;
  llm: LlmProvider;
  /** Red-team panel size per round. `<= 0` disables the critique (pass-through). */
  critics: number;
  /** Max critique→re-compile rounds. `<= 0` disables the critique (pass-through). */
  rounds: number;
  /**
   * Reads an authored verification file (workspace-relative path) so the panel can attack its
   * actual content, not just its name. A read failure drops that file from the prompt only.
   */
  readFile?: (rel: string) => Promise<string>;
  /**
   * Deterministic workspace-facts summary (see `detectWorkspaceFacts`), so the REPRODUCIBILITY
   * lens has ground truth to check the authored files against (module system, manifests) instead
   * of guessing. Trusted operator-side data — not worker content, so not fenced. Absent ⇒ omitted.
   */
  facts?: string;
  logger?: Logger;
};

/**
 * Contract red-team (`--adversarial`) — a decorator BEHIND the unchanged {@link VerifierCompiler}
 * seam: compile, let an adversarial panel attack the not-yet-sealed contract, and on any critical
 * finding re-compile with the findings as authoring feedback (the same free-text channel a Seal
 * "revise" uses), bounded by `rounds`. Runs strictly BEFORE freeze/Seal, so invariant #2 holds:
 * every attempt is frozen + logged on its own and the Seal gate still decides what enters the loop.
 *
 * ADVISORY, fail-open (the pre-flight's carve-out): a throwing/unparseable panel passes the
 * original contract through — a broken critic can only mean fewer revise rounds, never a blocked
 * run or a skipped gate. Skipped entirely for `verifier.kind === 'existing'`: the user pointed at
 * their own bar, and there is nothing authored to red-team.
 */
export class CritiquedCompiler implements VerifierCompiler {
  readonly #inner: VerifierCompiler;
  readonly #llm: LlmProvider;
  readonly #critics: number;
  readonly #rounds: number;
  readonly #readFile: ((rel: string) => Promise<string>) | undefined;
  readonly #facts: string | undefined;
  readonly #logger: Logger;

  constructor(opts: CritiquedCompilerOpts) {
    this.#inner = opts.inner;
    this.#llm = opts.llm;
    this.#critics = opts.critics;
    this.#rounds = opts.rounds;
    this.#readFile = opts.readFile;
    this.#facts = opts.facts;
    this.#logger = opts.logger ?? noopLogger;
  }

  async compile(input: ContractInput, feedback?: string): Promise<CompiledContract> {
    let contract = await this.#inner.compile(input, feedback);
    if (input.verifier.kind === 'existing' || this.#critics <= 0 || this.#rounds <= 0) {
      return contract;
    }

    for (let round = 1; round <= this.#rounds; round += 1) {
      const prompt = await this.#buildPrompt(input.goal, contract);
      const outputs = await runCriticPanel({
        llm: this.#llm,
        system: SYSTEM_PROMPT,
        prompt,
        lenses: CONTRACT_REDTEAM_LENSES,
        count: this.#critics,
      });
      if (outputs.length === 0) {
        // Every critic errored or returned garbage: advisory machinery, so pass the contract
        // through (the Seal still gates it) — but say so, loudly enough to notice.
        this.#logger.warn('contract red-team produced no parseable critiques; passing through', {
          round,
        });
        return contract;
      }
      const findings = criticalFindings(outputs);
      if (findings.length === 0) {
        this.#logger.info('contract red-team found no critical issues', { round });
        return contract;
      }
      const critique = renderCritiqueFeedback(findings);
      this.#logger.info('contract red-team found critical issues; re-authoring', {
        round,
        findings: findings.length,
      });
      // Compose the human's Seal feedback (when present) with the panel's findings so a revise
      // round never loses the operator's steer.
      const combined = feedback !== undefined && feedback.length > 0
        ? `${feedback}\n\n${critique}`
        : critique;
      contract = await this.#inner.compile(input, combined);
    }
    // Rounds exhausted: the last re-authored contract passes through — the Seal gate still stands.
    return contract;
  }

  async #buildPrompt(goal: string, contract: CompiledContract): Promise<string> {
    const parts = [
      `GOAL:\n${goal}`,
      `RUBRIC (to be frozen):\n${contract.rubric.length > 0 ? contract.rubric : '(empty)'}`,
      `VERIFIER LADDER (in execution order):\n${describeRungs(contract.rungs)}`,
      `SETUP (one-time, not a rung): ${contract.setup ?? '(none)'}`,
      `REQUIRED TOOLS: ${contract.requiredTools.length > 0 ? contract.requiredTools.join(', ') : '(none)'}`,
      ...(this.#facts !== undefined ? [this.#facts] : []),
    ];
    // The authored files are the tamper/hard-code surface — attack their content, fenced: the
    // authoring model may have folded repo context (worker-influenceable on a follow-up) into them.
    for (const file of contract.generatedFiles) {
      if (this.#readFile === undefined) break;
      try {
        const content = await this.#readFile(file.path);
        parts.push(
          `AUTHORED FILE ${file.path}:\n${wrapUntrusted(content, { label: 'AUTHORED FILE' })}`,
        );
      } catch {
        parts.push(`AUTHORED FILE ${file.path}: (unreadable)`);
      }
    }
    parts.push(
      'Attack this contract as the adversarial worker would. Reply with ONLY the JSON critique object.',
    );
    return parts.join('\n\n');
  }
}

function describeRungs(rungs: readonly Rung[]): string {
  return rungs
    .map((r, i) =>
      r.kind === 'deterministic'
        ? `  ${i + 1}. [deterministic${r.label !== undefined ? ` — ${r.label}` : ''}] ${r.command}`
        : `  ${i + 1}. [judge quorum=${r.quorum} confidenceFloor=${r.confidenceFloor}${
            r.label !== undefined ? ` — ${r.label}` : ''
          }] ${r.rubric}`,
    )
    .join('\n');
}
