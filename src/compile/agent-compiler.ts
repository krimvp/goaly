import { z } from 'zod';
import type { ContractInput } from '../domain/config';
import type { CompiledContract, GeneratedFile, Rung, UnhashedContract } from '../domain/contract';
import { freezeContract, sha256Hex } from '../util/hash';
import type { LlmProvider } from '../llm/provider';
import type { VerifierCompiler } from './compiler';
import { extractRequiredTools } from './required-tools';

/** Schema for the JSON the authoring LLM must emit (validated fail-closed). */
const GeneratedVerification = z.object({
  command: z.string().min(1),
  rubric: z.string(),
  /**
   * Optional one-time workspace bootstrap command (Fix #1): if the repo needs deps installed (or any
   * other one-time prep) before the verification can run, the authoring LLM puts that here (e.g.
   * `npm ci`). Runs once before the first agent turn; a `--setup-cmd` flag overrides it.
   */
  setup: z.string().optional(),
  /**
   * External programs the command/setup need to ALREADY be installed on PATH — the toolchain/runner
   * (e.g. ["cargo"] for Rust, ["python","pytest"] for Python, ["go"], ["node","npm"]). NOT project
   * files and NOT shell builtins. goaly probes these before the loop; a missing one is either installed
   * by the agent (default) or a typed `TOOLS_MISSING` abort. Omit when the command uses only builtins.
   */
  requiredTools: z.array(z.string().min(1)).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .optional(),
});
type GeneratedVerification = z.infer<typeof GeneratedVerification>;

const SYSTEM_PROMPT =
  'You author verification for software goals. Reply with ONLY a single JSON object, ' +
  'no prose, no markdown fences. Shape: ' +
  '{ "command": string, "rubric": string, "setup"?: string, ' +
  '"requiredTools"?: string[], "files"?: Array<{ "path": string, "content": string }> }. ' +
  'The command must exit 0 exactly when the goal is achieved.\n' +
  'Guardrails for a RUNNABLE bar (issue #55):\n' +
  '- The files you author are VERIFICATION ONLY — test files, fixtures, or a check script. NEVER ' +
  'author the implementation/solution itself (the source the goal asks for): writing that code is the ' +
  "WORKER's job, and the files you author are FROZEN (an anti-tamper guard pins them), so authoring " +
  'the solution into them deadlocks the worker — it cannot change a frozen file, and its real work ' +
  'then registers as no change. Your command MUST therefore FAIL on the CURRENT tree (the ' +
  'implementation does not exist yet) and pass only once the worker has written it.\n' +
  "- Author the command over the repo's EXISTING tooling (its test / build / lint runner). Do not " +
  'require ad-hoc shell scripts, nor `grep`/structural source checks as the bar.\n' +
  '- Write any helper or test file INSIDE the workspace using a RELATIVE path; never reference an ' +
  'absolute or out-of-repo path such as /tmp.\n' +
  '- The rubric must be checkable by RUNNING that command. Do not author a rubric that judges ' +
  'runtime / visual / "is it meaningful" behavior a grader cannot execute — express those as ' +
  'assertions inside the test suite instead.\n' +
  '- If the verification needs dependencies installed (or any one-time prep) before it can run, put ' +
  'that in "setup" (e.g. "npm ci", "pip install -r requirements.txt", "go mod download") so the ' +
  'worker starts from a populated tree. Use the lockfile-respecting install for the repo\'s manifest. ' +
  'Omit "setup" when no preparation is needed.\n' +
  '- List in "requiredTools" the external programs the command and setup assume ALREADY exist on PATH ' +
  '— the language toolchain and test runner (e.g. ["cargo"], ["python","pytest"], ["go"], ' +
  '["node","npm"]). These are what goaly probes (and installs, or aborts on) before the loop; do NOT ' +
  'list shell builtins or coreutils. Omit when the command relies only on builtins.';

/**
 * Extract the first balanced JSON object from a string. Tolerant of surrounding prose
 * or markdown fences the LLM may emit despite instructions. Returns the substring, or
 * undefined if no balanced object is found. String-literal aware (ignores braces in strings).
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/**
 * Reject a verification command that trivially exits 0 without measuring anything.
 * An autonomously-authored bar like `true`, `:`, or `exit 0` would pass both keys vacuously, so a
 * generated command made only of no-op segments is refused at compile (→ COMPILE_FAILED) rather
 * than frozen as a hollow contract. Conservative on purpose: it only flags commands whose EVERY
 * segment is a recognised no-op, so any real test/check command passes through untouched. This is
 * applied to the LLM-authored `--generate` command only; a user's explicit `--verify-cmd "true"`
 * is their own informed choice and is left alone.
 */
export function isVacuousCommand(command: string): boolean {
  const segments = command
    .split(/[\n;]|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return true;
  const NOOP = /^(true|:|exit(\s+0)?)$/;
  return segments.every((s) => NOOP.test(s));
}

/**
 * Reject a generated verification command that reaches OUTSIDE the repo (issue #55). The #48 dogfood
 * saw the compiler author a helper at `/tmp/goaly-phase-verify.sh` and invoke it — a bar that depends
 * on an out-of-workspace path is un-runnable by the grader (and the workspace write guard refuses the
 * file anyway → a raw throw). Catching it here turns it into a typed COMPILE_FAILED carrying an
 * actionable message, which the bounded compile-retry-with-feedback loop (issue #51) can self-correct.
 * Conservative: only flags an OS temp dir (`/tmp`, `/var/tmp`, `/var/folders`) appearing at the start
 * of a path token, so a normal command (`npm test`, `vitest run test/x.test.ts`) passes untouched.
 * Applied to LLM-authored `--generate` commands only.
 */
export function referencesOutOfRepoPath(command: string): boolean {
  return /(?:^|[\s='"(`])(?:\/tmp|\/var\/tmp|\/var\/folders)(?:\/|\b)/.test(command);
}

/**
 * Detect a timeout-shaped error from the verification-authoring LLM call (follow-on G). The CLI
 * providers throw `LLM CLI <name> timed out`; the OpenAI client surfaces a timed-out request as an
 * aborted fetch. Conservative: only timeout/abort phrasing, so a normal authoring error (bad JSON,
 * vacuous command) is untouched and keeps its own message.
 */
export function looksLikeLlmTimeout(message: string): boolean {
  return /\btimed\s*out\b|\btimeout\b|operation was aborted/i.test(message);
}

/** The actionable remedy folded into a timeout-`COMPILE_FAILED` (mirrors prepare.ts's exit-127 hint). */
const LLM_TIMEOUT_HINT =
  'Hint: the verification-authoring LLM call timed out — raise --llm-timeout-ms (current default ' +
  '600000) for large/parallel --generate authoring, or reduce concurrent load. Re-issuing the same ' +
  'heavy call will keep timing out, so bumping the timeout is the remedy, not more --max-compile-retries.';

/**
 * Wrap a timed-out authoring error with the raise-`--llm-timeout-ms` hint so it flows into the
 * COMPILE_FAILED reason; any non-timeout error is rethrown unchanged (its own message is the signal).
 */
function withTimeoutHint(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (!looksLikeLlmTimeout(message)) return e instanceof Error ? e : new Error(message);
  return new Error(`AgentCompiler: ${message}\n\n${LLM_TIMEOUT_HINT}`);
}

function parseGenerated(raw: string): GeneratedVerification {
  const json = extractBalancedJson(raw);
  if (json === undefined) {
    throw new Error('AgentCompiler: LLM response contained no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    throw new Error(`AgentCompiler: LLM response was not valid JSON: ${message}`);
  }
  return GeneratedVerification.parse(parsed);
}

/**
 * Build the ladder for a given command + rubric. Deterministic-tier rungs first (the main verify
 * command, then an optional artifact-running smoke command — issue #53 — both ungameable exit-code
 * checks), then an LLM-judge rung only when the rubric is a non-empty string. The smoke rung RUNS the
 * built artifact (`node smoke.mjs`, a headless-browser script, a server probe, …); it sits in the
 * deterministic tier before the judge so a runtime failure is caught deterministically, not guessed.
 */
function buildRungs(
  command: string,
  rubric: string,
  judge: ContractInput['judge'],
  smoke: string | undefined,
): Rung[] {
  const rungs: Rung[] = [{ kind: 'deterministic', command }];
  if (smoke !== undefined) {
    rungs.push({ kind: 'deterministic', command: smoke, label: 'smoke' });
  }
  if (rubric.length > 0) {
    rungs.push({
      kind: 'judge',
      rubric,
      quorum: judge.quorum,
      confidenceFloor: judge.confidenceFloor,
    });
  }
  return rungs;
}

/**
 * AgentCompiler — Phase 1 verifier compiler. Either wraps an existing command the user
 * pointed at (no LLM call), or has the LLM author fresh verification (command + rubric +
 * optional files), validates it fail-closed with Zod, writes any files, and freezes the
 * resulting contract. A throw here is turned into COMPILE_FAILED by the Driver.
 */
export class AgentCompiler implements VerifierCompiler {
  readonly #llm: LlmProvider;
  readonly #writeFile: ((relPath: string, content: string) => Promise<void>) | undefined;
  readonly #verifyDir: string | undefined;

  constructor(opts: {
    llm: LlmProvider;
    writeFile?: (relPath: string, content: string) => Promise<void>;
    /** Preferred directory (relative to the repo root) for authored verification files (issue #52). */
    verifyDir?: string;
  }) {
    this.#llm = opts.llm;
    this.#writeFile = opts.writeFile;
    this.#verifyDir = opts.verifyDir;
  }

  async compile(config: ContractInput, feedback?: string): Promise<CompiledContract> {
    if (config.verifier.kind === 'existing') {
      // An existing-command contract has no LLM authoring step, so there is nothing for a
      // Seal revise note to steer — recompilation is deterministic and feedback is ignored.
      return this.#compileExisting(config, config.verifier.ref);
    }
    return this.#compileGenerate(config, config.verifier.intent, feedback);
  }

  #compileExisting(config: ContractInput, ref: string): CompiledContract {
    const rubric = config.rubric ?? '';
    // No LLM authoring on the existing-command path, so setup comes ONLY from --setup-cmd (resolveSetup
    // drops it under --no-setup).
    const setup = resolveSetup(config, undefined);
    const unhashed: UnhashedContract = {
      goal: config.goal,
      rungs: buildRungs(ref, rubric, config.judge, config.smoke),
      rubric,
      generatedFiles: [],
      requiredTools: resolveRequiredTools(undefined, [ref, config.smoke, setup]),
      ...(setup !== undefined ? { setup } : {}),
    };
    return freezeContract(unhashed);
  }

  async #compileGenerate(
    config: ContractInput,
    intent: string | undefined,
    feedback: string | undefined,
  ): Promise<CompiledContract> {
    const guidanceParts = [`Goal: ${config.goal}`];
    if (intent !== undefined && intent.length > 0) {
      guidanceParts.push(`Intent: ${intent}`);
    }
    if (config.rubric !== undefined && config.rubric.length > 0) {
      guidanceParts.push(`Rubric guidance: ${config.rubric}`);
    }
    if (this.#verifyDir !== undefined && this.#verifyDir.length > 0) {
      guidanceParts.push(
        `Write any authored verification files under the '${this.#verifyDir}/' directory ` +
          '(a relative path inside the repo).',
      );
    }
    if (feedback !== undefined && feedback.length > 0) {
      guidanceParts.push(
        `Reviewer feedback on the previous contract attempt (revise accordingly): ${feedback}`,
      );
    }
    guidanceParts.push('Author verification as JSON only.');

    let raw: string;
    try {
      ({ text: raw } = await this.#llm.complete({
        system: SYSTEM_PROMPT,
        prompt: guidanceParts.join('\n'),
        temperature: 0,
      }));
    } catch (e) {
      // A timed-out authoring call is still a fail-closed COMPILE_FAILED (invariant #4), but re-issuing
      // the same heavy call burns compile-retries on a transient infra limit, not a model mistake
      // (follow-on G: sonnet's 3× COMPILE_FAILED were LLM timeouts 10 min apart = the default
      // --llm-timeout-ms). Surface the cause + remedy so the user raises the timeout instead.
      throw withTimeoutHint(e);
    }

    const generated = parseGenerated(raw);

    if (isVacuousCommand(generated.command)) {
      throw new Error(
        `AgentCompiler: refusing to freeze a vacuous verification command ('${generated.command}') ` +
          'that passes without measuring the goal — author a command that fails until the goal is met',
      );
    }

    if (referencesOutOfRepoPath(generated.command)) {
      throw new Error(
        `AgentCompiler: refusing a verification command that references an out-of-repo path ` +
          `('${generated.command}') — author the bar over the repo's existing tooling and keep any ` +
          'helper file inside the workspace (a relative path)',
      );
    }

    // Pin each authored file by the hash of the exact content we write, so the integrity guard can detect
    // any later tampering with the bar. Content hashing matches GitWorkspace.fileHash (sha256 of the
    // utf8 content).
    const generatedFiles: GeneratedFile[] = [];
    if (generated.files !== undefined && this.#writeFile !== undefined) {
      for (const file of generated.files) {
        await this.#writeFile(file.path, file.content);
        generatedFiles.push({ path: file.path, sha256: sha256Hex(file.content) });
      }
    }

    // Setup precedence: --setup-cmd overrides the LLM-authored command; --no-setup drops both.
    const setup = resolveSetup(config, generated.setup);
    const unhashed: UnhashedContract = {
      goal: config.goal,
      rungs: buildRungs(generated.command, generated.rubric, config.judge, config.smoke),
      rubric: generated.rubric,
      generatedFiles,
      requiredTools: resolveRequiredTools(generated.requiredTools, [
        generated.command,
        config.smoke,
        setup,
      ]),
      ...(setup !== undefined ? { setup } : {}),
    };
    return freezeContract(unhashed);
  }
}

/**
 * Resolve the frozen required-tools manifest. The authored list (LLM under `--generate`) is primary;
 * when it is absent/empty — always on the `--verify-cmd` path — fall back to a heuristic parse of the
 * frozen commands. Trims/dedupes; returns `[]` for a tool-less bar. (User chose "LLM manifest + heuristic
 * fallback".)
 */
function resolveRequiredTools(
  authored: readonly string[] | undefined,
  commands: readonly (string | undefined)[],
): string[] {
  const cleaned = dedupe((authored ?? []).map((t) => t.trim()).filter((t) => t.length > 0));
  if (cleaned.length > 0) return cleaned;
  return extractRequiredTools(commands.filter((c): c is string => c !== undefined));
}

/** Distinct values in first-seen order. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve the frozen setup command (Fix #1) from the config override and the LLM-authored value.
 * Precedence: `--no-setup` disables it entirely; otherwise `--setup-cmd` wins over what the compiler
 * authored. A blank authored string is treated as "no setup". Returns undefined when there is none.
 */
function resolveSetup(config: ContractInput, authored: string | undefined): string | undefined {
  if (config.noSetup) return undefined;
  if (config.setupCmd !== undefined) return config.setupCmd;
  const trimmed = authored?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
