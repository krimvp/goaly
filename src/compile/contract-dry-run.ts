import { z } from 'zod';
import type { ContractInput } from '../domain/config';
import type { CompiledContract, Rung } from '../domain/contract';
import type { LlmProvider } from '../llm/provider';
import { noopLogger, type Logger } from '../log/logger';
import { errorMessage } from '../util/errors';
import { extractBalancedJson } from '../util/json-extract';
import { executionErrorReason } from '../verify/deterministic';
import { UNTRUSTED_SYSTEM_CLAUSE, wrapUntrusted } from '../verify/prompt-safety';
import type { ScratchCopy, ScratchHost } from '../workspace/scratch-copy';
import type { VerifierCompiler } from './compiler';
import { SATISFIABILITY_GUARDRAIL } from './critiqued-compiler';
import { namesFrozenFile } from './frozen-paths';

/**
 * Max chars of a rung's own command echoed into the refusal, so one pathological command line
 * cannot fill the reason (and, through it, the run log). The command is contract data goaly froze,
 * not runner output — this is a log-hygiene bound, not a containment one.
 */
const COMMAND_LIMIT = 300;

/**
 * Why the refusal quotes nothing the rung printed. Stated to the author, because an author who
 * believes output was merely *omitted* will ask for it back.
 */
const NO_OUTPUT_NOTICE =
  'Whatever the rung printed is NOT shown, and was not read at all. On this run the tree it ' +
  'ran against also held a throwaway reference implementation of the goal, and a test runner reports ' +
  'a failure by printing the source of the code under test — so its stdout and stderr are one ' +
  'stream in which runner text and reference text are interleaved, with no way to tell them apart. ' +
  'You do not need it: you AUTHORED the verification files, so you already know what they assert. ' +
  'What you could not know is WHICH bar a correct implementation failed to clear, and that is stated ' +
  'above.';

/** Default kill-timeout for each scratch command (setup + each rung) — the 10 min the ladder uses. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The throwaway reference implementation, validated fail-closed (invariant #6). Files only: it is
 * code written into a scratch copy and destroyed — it carries no command, no rubric, and nothing
 * that could reach the frozen contract.
 */
const ReferenceImplementation = z.object({
  files: z
    .array(z.object({ path: z.string().min(1), content: z.string() }))
    .min(1),
});
type ReferenceImplementation = z.infer<typeof ReferenceImplementation>;

const SYSTEM_PROMPT =
  'You write a THROWAWAY REFERENCE IMPLEMENTATION used as a positive control on a verification ' +
  'contract before it is frozen. Your code is written ONLY into a disposable scratch copy of the ' +
  'workspace, the verification is run against it once, and the copy is deleted immediately. It is ' +
  'never shown to the worker, never committed, and never enters the frozen contract — so write the ' +
  'most direct, complete implementation of the goal you can, not a stub and not a sketch.\n' +
  'Rules:\n' +
  '- Implement the GOAL so that the verification command shown below PASSES. Do not try to detect, ' +
  'special-case or hard-code against the test: a special-cased implementation makes the control ' +
  'worthless.\n' +
  '- NEVER emit any of the AUTHORED VERIFICATION FILES listed below (they are frozen, and any such ' +
  'file you emit is discarded). Write the implementation source the goal asks for, nothing else.\n' +
  '- Use RELATIVE paths inside the workspace. Emit the FULL content of each file.\n' +
  'Reply with ONLY a single JSON object, no prose, no markdown fences, matching exactly: ' +
  '{ "files": Array<{ "path": string, "content": string }> }. ' +
  UNTRUSTED_SYSTEM_CLAUSE;

const CLOSING =
  'Write the reference implementation that makes the verification above pass. JSON only.';

/**
 * What one positive control concluded.
 *
 * - `green` — a reference implementation greened the deterministic rungs: the bar is SATISFIABLE.
 * - `red` — it did not: the bar is defective and the freeze is refused.
 * - `skipped` — the control could not be performed at all (no reference authored, scratch failure,
 *   setup could not run, a rung timed out / could not be started). FAIL-OPEN: the contract freezes
 *   exactly as it does today. A dry run must never be the reason a legitimate run cannot start.
 */
export type DryRunOutcome =
  | { status: 'green' }
  | { status: 'red'; rung: string; detail: string }
  | { status: 'skipped'; reason: string };

export type ContractDryRunOpts = {
  inner: VerifierCompiler;
  llm: LlmProvider;
  scratch: ScratchHost;
  /** Kill-timeout for each scratch command (the contract's setup, then each deterministic rung). */
  timeoutMs?: number;
  /**
   * Reads an authored verification file (workspace-relative path) so the reference implementation is
   * written against the bar's ACTUAL assertions, not just its name. A read failure drops that file
   * from the prompt only.
   */
  readFile?: (rel: string) => Promise<string>;
  /** Deterministic workspace-facts summary (see `detectWorkspaceFacts`); absent ⇒ omitted. */
  facts?: string;
  logger?: Logger;
};

/**
 * COMPILE-TIME POSITIVE CONTROL (issue #115) — a decorator BEHIND the unchanged
 * {@link VerifierCompiler} seam, running strictly BEFORE the freeze/Seal.
 *
 * The pre-flight gives the frozen bar a NEGATIVE control: it must be RED on the from-scratch tree
 * (and `classifyVacuousContract` catches a bar that is already green). Nothing proved the other
 * half — that the bar can EVER go green. A bar no implementation can satisfy passes pre-flight (its
 * red is indistinguishable from an honest implementation-missing red) and the run is unwinnable
 * from that moment: issue #114 burned ~39 min and ~2M tokens against one authored assertion
 * (`expect(spy).toHaveBeenCalled()` placed AFTER `spy.mockRestore()`) that no implementation can pass.
 *
 * So: have the compiler's model also author a throwaway REFERENCE IMPLEMENTATION, materialize it in
 * a SCRATCH COPY of the workspace alongside the already-authored verification files, and run the
 * contract's DETERMINISTIC rungs there (judge rungs are out of scope — an LLM rubric cannot be
 * positively controlled by execution). Green ⇒ discard the scratch and freeze as normal. Red ⇒ the
 * bar is defective: THROW, which the Driver turns into a `COMPILE_FAILED` and the existing bounded
 * re-author loop (`--max-compile-retries`, issue #51) feeds back to the author. This is the only
 * guard in the design that answers "can this bar be met?" by EXECUTION rather than by asking a model
 * its opinion.
 *
 * CRITICAL SAFETY — the reference implementation is written ONLY to the {@link ScratchCopy}, which
 * is destroyed on every exit path. It never touches the workspace and never enters the run diff.
 * Leaking it would hand the worker the solution and recreate exactly the deadlock
 * `classifyVacuousContract` exists to catch. A file whose path names a frozen `generatedFiles`
 * entry is DISCARDED — by {@link namesFrozenFile}, over the same canonical form the scratch copy's
 * own `resolve(root, relPath)` produces — so the control can never quietly rewrite the bar it
 * measures.
 *
 * The one channel OUT of the scratch is the refusal reason: it becomes `COMPILE_FAILED.reason` and
 * IS fed back to the contract author (and, through the author, into the frozen files a worker then
 * reads). THAT CHANNEL CARRIES NO RUNNER OUTPUT — not one byte of the scratch subprocess's stdout or
 * stderr is read. The refusal is built entirely from data goaly owns: the exit code, and which rung
 * of the frozen contract failed (its position, label and command). See {@link rungFailureDetail}.
 *
 * This is not a filter that got stricter; it is the removal of the channel a filter was guarding.
 * Four successive sanitizers over `${stdout}\n${stderr}` were defeated in turn — a per-line
 * blacklist, a structured summary, a path check, a positive/frame-context whitelist — because the
 * reference implementation WRITES TO THOSE STREAMS. Runner text and reference text are interleaved
 * in one adversary-writable stream, so provenance is not recoverable by shape: the reference can
 * print prose, source, marker-shaped lines, `\r`-merged lines, or lines ending in the frozen file's
 * own path, and be indistinguishable from the runner. The cost of dropping it is small, because THE
 * COMPILER ALREADY HAS THE FROZEN VERIFICATION FILES — IT AUTHORED THEM. It does not need the
 * runner to tell it what its own assertions say; it needs to know which bar failed, and that it
 * failed. That is exactly what remains.
 *
 * FAIL-OPEN on infrastructure: no LLM, an unparseable reference, a scratch-copy failure, a setup
 * that cannot run, a timed-out or unstartable rung — all log and freeze as today. Like every other
 * compile-phase guard it can only REJECT a contract or step aside; it can never turn a red bar green
 * or relax a rung, so invariants #2/#3/#4 are untouched (and the loop never sees any of this).
 */
export class ContractDryRunCompiler implements VerifierCompiler {
  readonly #inner: VerifierCompiler;
  readonly #llm: LlmProvider;
  readonly #scratch: ScratchHost;
  readonly #timeoutMs: number;
  readonly #readFile: ((rel: string) => Promise<string>) | undefined;
  readonly #facts: string | undefined;
  readonly #logger: Logger;

  constructor(opts: ContractDryRunOpts) {
    this.#inner = opts.inner;
    this.#llm = opts.llm;
    this.#scratch = opts.scratch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#readFile = opts.readFile;
    this.#facts = opts.facts;
    this.#logger = opts.logger ?? noopLogger;
  }

  async compile(input: ContractInput, feedback?: string): Promise<CompiledContract> {
    const contract = await this.#inner.compile(input, feedback);
    // Nothing authored ⇒ nothing to positively control. A user `--verify-cmd` is the user's OWN bar
    // (they own its satisfiability), and a contract with no authored files has no frozen assertions
    // that could be unsatisfiable in a way the worker cannot fix.
    if (input.verifier.kind === 'existing' || contract.generatedFiles.length === 0) return contract;
    const rungs = contract.rungs.filter(isDeterministic);
    if (rungs.length === 0) return contract;

    const outcome = await this.#control(input, contract, rungs);
    if (outcome.status === 'skipped') {
      this.#logger.warn('contract dry run could not be performed — freezing as usual (fail-open)', {
        reason: outcome.reason,
      });
      return contract;
    }
    if (outcome.status === 'green') {
      this.#logger.info('contract dry run: a reference implementation greened the frozen bar', {
        rungs: rungs.length,
      });
      return contract;
    }
    this.#logger.error(
      'contract dry run: a reference implementation could NOT green the bar — refusing the freeze',
      { rung: outcome.rung },
    );
    throw new Error(unsatisfiableReason(outcome.rung, outcome.detail));
  }

  /** Author the reference, materialize it in a scratch copy, run the deterministic rungs there. */
  async #control(
    input: ContractInput,
    contract: CompiledContract,
    rungs: readonly DeterministicRung[],
  ): Promise<DryRunOutcome> {
    let reference: ReferenceImplementation;
    try {
      reference = await this.#authorReference(input, contract);
    } catch (e) {
      return { status: 'skipped', reason: `no reference implementation: ${errorMessage(e)}` };
    }

    // The bar must be measured EXACTLY as authored: a reference file that collides with a frozen
    // verification path would rewrite the very assertions under test, so it is dropped outright.
    // The check runs over the SAME canonical form the scratch copy's own `resolve(root, relPath)`
    // produces — when it did not, a merely dotted spelling (`verify/./check.mjs`) was judged
    // unfrozen here and still landed on the frozen file, silently turning an unsatisfiable bar into
    // a green.
    const pinned = contract.generatedFiles.map((f) => f.path);
    const files = reference.files.filter((f) => !namesFrozenFile(f.path, pinned));
    if (files.length < reference.files.length) {
      this.#logger.warn('contract dry run: discarded reference files that collide with the frozen bar', {
        discarded: reference.files.length - files.length,
      });
    }
    if (files.length === 0) {
      return { status: 'skipped', reason: 'the reference implementation touched only frozen files' };
    }

    let copy: ScratchCopy | undefined;
    try {
      copy = await this.#scratch.create();
      for (const file of files) await copy.writeFile(file.path, file.content);
      return await this.#runRungs(copy, contract, rungs);
    } catch (e) {
      return { status: 'skipped', reason: errorMessage(e) };
    } finally {
      // EVERY exit path destroys the copy — this is what keeps the reference implementation out of
      // the workspace, the run diff, and any worker prompt.
      if (copy !== undefined) await this.#scratch.destroy(copy);
    }
  }

  /** Run the contract's setup (if any) then each deterministic rung in the scratch copy. */
  async #runRungs(
    copy: ScratchCopy,
    contract: CompiledContract,
    rungs: readonly DeterministicRung[],
  ): Promise<DryRunOutcome> {
    if (contract.setup !== undefined) {
      const s = await copy.run(contract.setup, { timeoutMs: this.#timeoutMs });
      if (s.exitCode !== 0) {
        // The bootstrap could not run here (no network, a toolchain the scratch lacks). We cannot
        // tell that apart from a defective bar, so we step aside rather than red a legitimate bar.
        return {
          status: 'skipped',
          reason: `the contract's setup could not run in the scratch copy (exit ${s.exitCode})`,
        };
      }
    }
    for (const [i, rung] of rungs.entries()) {
      const r = await copy.run(rung.command, { timeoutMs: this.#timeoutMs });
      // A rung that timed out or could not be started never produced a real pass/fail — the same
      // could-not-EVALUATE facts goaly owns at verify time. Fail-open, never a red.
      // `executionErrorReason` classifies from goaly's OWN facts (its timeout flag, its spawn
      // failure), not from the command's text, so no stream content reaches the reason here either.
      const unevaluable = executionErrorReason(r);
      if (unevaluable !== null) {
        return { status: 'skipped', reason: `\`${rung.command}\`: ${unevaluable}` };
      }
      if (r.exitCode !== 0) {
        // `r.stdout` / `r.stderr` are DELIBERATELY not read. See the class doc: the tree that just
        // failed contains the reference implementation, which writes to those same streams.
        return {
          status: 'red',
          rung: rung.label ?? rung.command,
          detail: rungFailureDetail(rung, i, rungs.length, r.exitCode),
        };
      }
    }
    return { status: 'green' };
  }

  async #authorReference(
    input: ContractInput,
    contract: CompiledContract,
  ): Promise<ReferenceImplementation> {
    const { text } = await this.#llm.complete({
      system: SYSTEM_PROMPT,
      prompt: await this.#buildPrompt(input, contract),
      temperature: 0,
    });
    const json = extractBalancedJson(text);
    if (json === undefined) throw new Error('the response contained no JSON object');
    return ReferenceImplementation.parse(JSON.parse(json));
  }

  async #buildPrompt(input: ContractInput, contract: CompiledContract): Promise<string> {
    const parts = [
      `GOAL:\n${input.goal}`,
      `VERIFICATION COMMANDS (deterministic; your implementation must make ALL of them exit 0):\n${
        contract.rungs.filter(isDeterministic).map((r) => `  - ${r.command}`).join('\n')
      }`,
      `SETUP (already run before the commands): ${contract.setup ?? '(none)'}`,
      `AUTHORED VERIFICATION FILES (FROZEN — never emit these paths): ${contract.generatedFiles
        .map((f) => f.path)
        .join(', ')}`,
      ...(this.#facts !== undefined ? [this.#facts] : []),
    ];
    // The authored files are the actual assertions to satisfy. Fenced: the authoring model may have
    // folded repo context (worker-influenceable on a follow-up) into them.
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
    parts.push(CLOSING);
    return parts.join('\n\n');
  }
}

type DeterministicRung = Extract<Rung, { kind: 'deterministic' }>;

function isDeterministic(rung: Rung): rung is DeterministicRung {
  return rung.kind === 'deterministic';
}

/**
 * The structured description of a failed rung, built ONLY from values goaly owns: the exit code the
 * OS reported, and the rung's own position/label/command inside the contract goaly just compiled.
 *
 * Every one of these is contract data or a process-level fact. None of them travelled through the
 * scratch subprocess's stdout or stderr, which is why this function takes no output argument — the
 * type makes the guarantee, so a future edit cannot quietly re-open the channel by "just adding a
 * little context". Only the command is length-bounded, and purely for log hygiene.
 */
export function rungFailureDetail(
  rung: DeterministicRung,
  index: number,
  total: number,
  exitCode: number,
): string {
  const label = rung.label !== undefined ? ` (${rung.label})` : '';
  return [
    `exit ${exitCode}`,
    `failing rung: ${index + 1} of ${total}${label} — \`${bound(rung.command, COMMAND_LIMIT)}\``,
    NO_OUTPUT_NOTICE,
  ].join('\n');
}

/** Truncate to `max` chars with an ellipsis, so one long value cannot fill the reason. */
function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * The refusal fed to the bounded re-author loop. It names the failing rung and carries
 * {@link rungFailureDetail} — the exit code and which frozen rung failed. It carries NOTHING the
 * rung printed: an author receiving a working solution would fold it into the frozen verification
 * files, which is precisely the deadlock this whole guard exists to prevent, and the rung's output
 * cannot be separated from the reference implementation's (see the class doc). Closes with the
 * anti-softening rail so "make it satisfiable" can never be read as "make it easier".
 */
export function unsatisfiableReason(rung: string, detail: string): string {
  return (
    'ContractDryRun: refusing to freeze an UNSATISFIABLE bar. A reference implementation of the ' +
    'goal, written independently and run against the authored verification files in a throwaway ' +
    `scratch copy of the workspace, still FAILED the deterministic rung \`${rung}\`:\n${detail}\n\n` +
    'A bar a correct, complete implementation cannot pass reds every iteration and burns the whole ' +
    'run. Re-author the verification so a correct implementation PASSES it. ' +
    SATISFIABILITY_GUARDRAIL
  );
}
