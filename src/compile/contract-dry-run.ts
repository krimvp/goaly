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

/** Max chars of a failing rung's output folded into the refusal reason, so the run log stays bounded. */
const DETAIL_LIMIT = 2000;

/** A test runner's source-frame gutter (`      4|   const x = 1;`) — verbatim source, always dropped. */
const GUTTER_LINE = /^\s*\d+\s*\|/;

/** The caret line that closes a frame block (`        |          ^` or `  ^`). */
const CARET_LINE = /^\s*\|?\s*\^+\s*$/;

/** A path-ish token containing a separator (`src/impl.ts`, `/tmp/x/impl.ts:5:9`, `node:internal/x`). */
const SLASH_REF = /[\w.@~+-]*(?:\/[\w.@~+-]+)+(?::\d+(?::\d+)?)?/g;

/** A bare `file.ext:LINE[:COL]` reference (a runner frame printed without a directory). */
const FILE_LINE_REF = /[\w.@+-]+\.[A-Za-z]\w{0,6}:\d+(?::\d+)?/g;

/** Stands in for a failing rung whose whole output spoke only about files outside the frozen bar. */
const WITHHELD =
  '(the rung printed nothing that names the frozen verification files — its output was withheld ' +
  'because on this run it quotes the throwaway reference implementation, which you must not see)';

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
 * `classifyVacuousContract` exists to catch. A file whose path collides with a frozen
 * `generatedFiles` entry is DISCARDED, so the control can never quietly rewrite the bar it measures.
 *
 * The one channel OUT of the scratch is the refusal reason: it becomes `COMPILE_FAILED.reason` and
 * IS fed back to the contract author (and, through the author, into the frozen files a worker then
 * reads). A test runner reds by printing the source of the implementation under test — which on a
 * red is precisely the reference — so the failing rung's output is never passed through raw: it goes
 * through {@link sanitizeRungOutput}, which keeps the exit code, the assertion message and frames
 * naming the frozen files, and drops every gutter block and every frame naming anything else.
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
    const pinned = new Set(contract.generatedFiles.map((f) => normalizeRel(f.path)));
    const files = reference.files.filter((f) => !pinned.has(normalizeRel(f.path)));
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
    for (const rung of rungs) {
      const r = await copy.run(rung.command, { timeoutMs: this.#timeoutMs });
      // A rung that timed out or could not be started never produced a real pass/fail — the same
      // could-not-EVALUATE facts goaly owns at verify time. Fail-open, never a red.
      const unevaluable = executionErrorReason(r);
      if (unevaluable !== null) {
        return { status: 'skipped', reason: `\`${rung.command}\`: ${unevaluable}` };
      }
      if (r.exitCode !== 0) {
        // The tree that just failed CONTAINS the reference implementation, so the runner's own
        // output quotes it (code frames, stack frames). Sanitize before it can reach the author.
        const clean = sanitizeRungOutput(r.stderr || r.stdout, contract.generatedFiles.map((f) => f.path));
        const detail = clean.length > 0 ? clean : WITHHELD;
        return {
          status: 'red',
          rung: rung.label ?? rung.command,
          detail: `exit ${r.exitCode}\n${detail.slice(0, DETAIL_LIMIT)}`,
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

/** Normalize a workspace-relative path for collision comparison: trim, drop a leading `./`. */
function normalizeRel(p: string): string {
  const t = p.trim();
  return t.startsWith('./') ? t.slice(2) : t;
}

/**
 * Every file-ish token on one output line, with any `:LINE[:COL]` suffix stripped. Directory-bearing
 * tokens are matched first and BLANKED OUT before the bare `file.ext:LINE` pass, so one frame never
 * yields both `verify/check.test.mjs` and a truncated `check.test.mjs` (which would look unfrozen).
 */
function fileRefs(line: string): string[] {
  const slashed = line.match(SLASH_REF) ?? [];
  const bare = line.replace(SLASH_REF, ' ').match(FILE_LINE_REF) ?? [];
  return [...slashed, ...bare].map((t) => t.replace(/(?::\d+)+$/, ''));
}

/** True when `ref` names one of the frozen verification files (path suffix match, any prefix). */
function namesFrozenFile(ref: string, frozen: readonly string[]): boolean {
  const token = normalizeRel(ref);
  return frozen.some((f) => token === f || token.endsWith(`/${f}`));
}

/** A bare location header (`/tmp/x/src/impl.ts:2`) — node prints the offending SOURCE right after it. */
function isLocationHeader(line: string): boolean {
  return /^\s*\S+:\d+(?::\d+)?\s*$/.test(line);
}

/**
 * Strip everything that could quote the REFERENCE IMPLEMENTATION out of a failing rung's output.
 *
 * The rung failed inside a tree that contains the reference, and every real test runner reports a
 * failure by printing the implementation's source: code-frame gutters (`  4|  …`) and stack frames
 * naming its files. That output becomes `COMPILE_FAILED.reason` and is fed verbatim back to the
 * contract author — so the author would receive a working solution and could fold it into the frozen
 * verification files (a wrong-GREEN at t=0, with `classifyVacuousContract` failing open).
 *
 * Whitelist, never blacklist: a line is kept only when it names NO file at all (the assertion
 * message) or names ONLY frozen `generatedFiles` (the bar's own frames). Gutter/caret blocks go
 * unconditionally, and a dropped location header takes its trailing source block with it.
 */
export function sanitizeRungOutput(raw: string, frozen: readonly string[]): string {
  const paths = frozen.map(normalizeRel);
  const kept: string[] = [];
  let suppressing = false;
  for (const line of raw.split('\n')) {
    if (suppressing) {
      if (line.trim().length === 0) suppressing = false;
      continue;
    }
    if (GUTTER_LINE.test(line) || CARET_LINE.test(line)) continue;
    const refs = fileRefs(line);
    if (refs.length > 0 && !refs.every((r) => namesFrozenFile(r, paths))) {
      suppressing = isLocationHeader(line);
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * The refusal fed to the bounded re-author loop. It names the failing rung and quotes its output —
 * already SANITIZED by {@link sanitizeRungOutput}, so what reaches the author is the assertion and
 * the frozen files' own frames, never the reference implementation: an author receiving a working
 * solution would fold it into the frozen verification files, which is precisely the deadlock this
 * whole guard exists to prevent. Closes with the anti-softening rail so "make it satisfiable" can
 * never be read as "make it easier".
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
