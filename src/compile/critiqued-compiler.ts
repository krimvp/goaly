import type { ContractInput } from '../domain/config';
import type { CompiledContract, Rung } from '../domain/contract';
import { criticalFindings, renderCritiqueFeedback, type CritiqueOutput } from '../domain/critique';
import { runCriticPanel } from '../llm/critic-panel';
import type { LlmProvider } from '../llm/provider';
import { noopLogger, type Logger } from '../log/logger';
import { UNTRUSTED_SYSTEM_CLAUSE, wrapUntrusted } from '../verify/prompt-safety';
import type { VerifierCompiler } from './compiler';

const SYSTEM_PROMPT =
  'You are a red-teamer attacking a verification contract BEFORE it is sealed and frozen for an ' +
  'automated goal loop. The contract must be sound in BOTH directions: a worker that has NOT met ' +
  'the goal must be unable to green it, and a worker that HAS met the goal must be able to green ' +
  'it. Assume the worker is lazy and adversarial: find how it could GAME this bar, how the bar ' +
  'could fail to evaluate, or how the bar would RED a correct, complete implementation. Look for: ' +
  'a verify command that passes vacuously or without exercising the goal; a rubric that diverges ' +
  'from what the command actually measures; authored test files with tautological or empty ' +
  'assertions, or expected outputs a worker could hard-code against; a bar satisfiable by a ' +
  'parallel reimplementation that never uses the artifact the goal is about; missing required ' +
  'tools that will make the bar unevaluable; a setup or verify command that needs the network at ' +
  'verify time; and assertions that NO implementation could ever satisfy. Mark a finding ' +
  '"critical" ONLY if (a) the worker could green this bar without genuinely meeting the goal, ' +
  '(b) the bar cannot be evaluated at all, or (c) you can NAME a correct, complete implementation ' +
  'of the goal that this bar would still FAIL. Everything else is "minor". Strictness is NOT a ' +
  'defect: a bar being demanding, thorough, or hard to pass is never a finding, and you must NEVER ' +
  'ask for a bar to be weakened, loosened, relaxed or made easier. A (c) finding may ask ONLY that ' +
  'the bar be made SATISFIABLE by a correct implementation while staying exactly as strict. ' +
  'Respond with ONLY a single JSON object, no prose, no markdown fences, matching exactly: ' +
  '{ "verdict": "pass" | "revise", "findings": Array<{ "severity": "critical" | "minor", ' +
  '"lens"?: string, "claim": string, "fix"?: string }> }. A "revise" verdict MUST carry at least ' +
  'one finding. ' +
  UNTRUSTED_SYSTEM_CLAUSE;

/**
 * The FALSE-RED lens (issue #118): the mirror of the other four, which all attack false GREENS.
 * Also runs ALONE, as the default-on satisfiability critic under `--generate` (see
 * {@link CritiquedCompilerOpts.satisfiability}). A false red costs the whole run — the loop burns
 * iterations against a bar no implementation can pass — so it is worth one LLM call at compile time.
 */
export const SATISFIABILITY_LENS =
  'FALSE-RED / SATISFIABILITY — could a CORRECT, COMPLETE implementation of the goal still FAIL ' +
  'this bar? Look for: assertions that cannot hold for ANY implementation — above all a spy/mock ' +
  'CALL-COUNT assertion made AFTER the spy was restored or reset (vitest `mockRestore()` / ' +
  '`mockReset()` / `restoreAllMocks()` and jest `restoreAllMocks()` CLEAR `mock.calls`, so a later ' +
  '`expect(spy).toHaveBeenCalled()` reds a perfectly correct implementation), or an assertion on ' +
  'state the test itself has already torn down (an afterEach/finally that resets before the ' +
  'assertion reads it); bars over-coupled to ONE import graph, file layout, or internal structure ' +
  'rather than the observable behavior the goal names; assertions on nondeterministic values ' +
  '(wall-clock timing, collection/iteration ordering, generated ids, exact floating-point ' +
  'equality); assertions that depend on the environment (locale, timezone, CPU count, network, ' +
  'absolute paths) rather than on the goal. Mark "critical" ONLY if you can NAME a correct ' +
  'implementation this bar would still red, and say how to make the bar SATISFIABLE without ' +
  'making it any weaker. A bar that is merely strict, thorough or demanding is NOT a finding.';

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
  SATISFIABILITY_LENS,
];

/**
 * The anti-softening rail appended to every re-author feedback (issue #118). Admitting false-RED
 * findings as "critical" opens one risk — a critic arguing a legitimately strict bar into being
 * weakened — so the instruction the author actually receives says "make it satisfiable", never
 * "make it easier", and restates the negative control (the bar must still be red on the tree today).
 */
export const SATISFIABILITY_GUARDRAIL =
  'When a finding says a CORRECT, COMPLETE implementation could still FAIL this bar, make that bar ' +
  'SATISFIABLE by a correct implementation — never make it easier. Keep it exactly as strict: do ' +
  'not delete, weaken or loosen any assertion a correct implementation would already pass, and the ' +
  're-authored bar must still FAIL on the current (unimplemented) tree.';

const REDTEAM_CLOSING =
  'Attack this contract as the adversarial worker would. Reply with ONLY the JSON critique object.';

const SATISFIABILITY_CLOSING =
  'Now do the opposite of gaming it: assume the worker writes a CORRECT, COMPLETE implementation of ' +
  'the goal, and check whether this bar would still fail it. Do NOT report a bar for being strict. ' +
  'Reply with ONLY the JSON critique object.';

export type CritiquedCompilerOpts = {
  inner: VerifierCompiler;
  llm: LlmProvider;
  /** Red-team panel size per round. `<= 0` disables the four-lens panel (not the satisfiability critic). */
  critics: number;
  /** Max critique→re-compile rounds. `<= 0` disables ALL critique (pass-through). */
  rounds: number;
  /**
   * Run the FALSE-RED satisfiability critic (issue #118): ONE extra call per round, under
   * {@link SATISFIABILITY_LENS} alone, whenever the compiled contract AUTHORED verification files.
   * Independent of the `--adversarial` panel and DEFAULT-ON under `--generate` (`--no-satisfiability-critic`
   * opts out): a false red costs the entire run, this costs one compile-time call. Its findings feed
   * the same bounded re-author loop, fenced by {@link SATISFIABILITY_GUARDRAIL}.
   */
  satisfiability?: boolean;
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
 * ALSO hosts the DEFAULT-ON satisfiability critic (issue #118): with `satisfiability: true` one
 * extra FALSE-RED call per round asks the mirror question — could a CORRECT implementation still
 * fail this bar? — and feeds the same re-author loop. It runs independently of `critics`, so a
 * default `--generate` run gets the false-red guard with the `--adversarial` panel still off.
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
  readonly #satisfiability: boolean;
  readonly #readFile: ((rel: string) => Promise<string>) | undefined;
  readonly #facts: string | undefined;
  readonly #logger: Logger;

  constructor(opts: CritiquedCompilerOpts) {
    this.#inner = opts.inner;
    this.#llm = opts.llm;
    this.#critics = opts.critics;
    this.#rounds = opts.rounds;
    this.#satisfiability = opts.satisfiability ?? false;
    this.#readFile = opts.readFile;
    this.#facts = opts.facts;
    this.#logger = opts.logger ?? noopLogger;
  }

  async compile(input: ContractInput, feedback?: string): Promise<CompiledContract> {
    let contract = await this.#inner.compile(input, feedback);
    if (input.verifier.kind === 'existing' || this.#rounds <= 0) return contract;
    if (this.#critics <= 0 && !this.#satisfiability) return contract;

    for (let round = 1; round <= this.#rounds; round += 1) {
      const outputs = await this.#critique(input.goal, contract);
      // Nothing was even eligible to run this round (e.g. the satisfiability critic alone, on a
      // contract that authored no files): not a failure, just nothing to say.
      if (outputs === undefined) return contract;
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
      const critique = `${renderCritiqueFeedback(findings)}\n\n${SATISFIABILITY_GUARDRAIL}`;
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

  /**
   * One critique round: the four-lens red-team panel (when enabled) plus the FALSE-RED
   * satisfiability critic (one call, when enabled and the contract authored files). Returns
   * `undefined` when NO critic was eligible to run — distinct from `[]` (critics ran, all dropped),
   * which is the fail-open pass-through the caller warns about.
   */
  async #critique(goal: string, contract: CompiledContract): Promise<CritiqueOutput[] | undefined> {
    const satisfiability = this.#satisfiability && contract.generatedFiles.length > 0;
    if (this.#critics <= 0 && !satisfiability) return undefined;
    const outputs: CritiqueOutput[] = [];
    if (this.#critics > 0) {
      outputs.push(
        ...(await runCriticPanel({
          llm: this.#llm,
          system: SYSTEM_PROMPT,
          prompt: await this.#buildPrompt(goal, contract, REDTEAM_CLOSING),
          lenses: CONTRACT_REDTEAM_LENSES,
          count: this.#critics,
        })),
      );
    }
    if (satisfiability) {
      outputs.push(
        ...(await runCriticPanel({
          llm: this.#llm,
          system: SYSTEM_PROMPT,
          prompt: await this.#buildPrompt(goal, contract, SATISFIABILITY_CLOSING),
          lenses: [SATISFIABILITY_LENS],
          count: 1,
        })),
      );
    }
    return outputs;
  }

  async #buildPrompt(
    goal: string,
    contract: CompiledContract,
    closing: string,
  ): Promise<string> {
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
    parts.push(closing);
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
