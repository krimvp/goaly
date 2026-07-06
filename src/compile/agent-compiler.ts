import { z } from 'zod';
import type { ContractInput } from '../domain/config';
import type { CompiledContract, GeneratedFile, Rung, UnhashedContract } from '../domain/contract';
import { freezeContract, sha256Hex } from '../util/hash';
import type { LlmProvider } from '../llm/provider';
import type { VerifierCompiler } from './compiler';
import { extractRequiredTools } from './required-tools';
import { extractBalancedJson, isTruncatedJson, TRUNCATED_JSON_MARKER } from '../util/json-extract';
import { findModuleFormatMismatch, type WorkspaceFacts } from '../workspace/workspace-facts';
import { UsageAssertion, enforceUsageAssertion, type UsageShape } from './usage-gate';

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
  /**
   * For a BUILD-AND-USE goal (build a reusable artifact AND use it), the declaration of the runtime
   * usage assertion the authored tests carry — proving the consumer routes through the artifact's
   * public API rather than a parallel reimplementation. The usage gate requires it (and that its
   * `targetSymbols` actually appear in an authored file) when the shape classifier flags build-and-use.
   * Omitted for non-build-and-use goals.
   */
  usageAssertion: UsageAssertion.optional(),
});
type GeneratedVerification = z.infer<typeof GeneratedVerification>;

const SYSTEM_PROMPT =
  'You author verification for software goals. Reply with ONLY a single JSON object, ' +
  'no prose, no markdown fences. Shape: ' +
  '{ "command": string, "rubric": string, "setup"?: string, ' +
  '"requiredTools"?: string[], "files"?: Array<{ "path": string, "content": string }>, ' +
  '"usageAssertion"?: { "targetSymbols": string[], "description": string } }. ' +
  'The command must exit 0 exactly when the goal is achieved.\n' +
  '- Explore the repository minimally before answering — read only what you need (a handful of ' +
  'files at most) to author the command and any files. A response that gets cut off mid-JSON because ' +
  'it explored too long fails closed and wastes a whole retry round. If you sense you are running low ' +
  'on turns or output budget, STOP exploring immediately and emit the complete JSON object now — a ' +
  'conservative-but-complete answer beats a thorough one that never finishes.\n' +
  'Guardrails for a RUNNABLE bar (issue #55):\n' +
  '- The files you author are VERIFICATION ONLY — test files, fixtures, or a check script. NEVER ' +
  'author the implementation/solution itself (the source the goal asks for): writing that code is the ' +
  "WORKER's job, and the files you author are FROZEN (an anti-tamper guard pins them), so authoring " +
  'the solution into them deadlocks the worker — it cannot change a frozen file, and its real work ' +
  'then registers as no change. Your command MUST therefore FAIL on the CURRENT tree (the ' +
  'implementation does not exist yet) and pass only once the worker has written it.\n' +
  "- Author the command over the repo's EXISTING tooling (its test / build / lint runner). Do not " +
  'require an ad-hoc shell script, nor a STATIC `grep`/source-text check, as the bar (a static ' +
  'source scan is gameable). A RUNTIME usage assertion that spies the real API and asserts it was ' +
  'actually invoked is NOT a static source scan — it runs the code — and is REQUIRED for build-and-use ' +
  'goals (see the next guardrail).\n' +
  '- USAGE / ANTI-REIMPLEMENTATION. When the goal is to BUILD a reusable artifact (a module, engine, ' +
  'library, class, or API) AND then USE it to accomplish something, a worker can satisfy a naive bar by ' +
  'writing a PARALLEL reimplementation inside the higher-level solvers/consumers that NEVER calls the ' +
  'artifact — greening the bar while the artifact the goal is about is dead code. Defeat this: author a ' +
  "RUNTIME usage assertion that instruments (spies/wraps/monkeypatches) the artifact's PUBLIC entry " +
  'points to count calls, runs the consumer, and asserts those entry points were actually invoked ' +
  '(call-count > 0) while producing the verified result — a reimplementation records zero calls and ' +
  'FAILS. Put that assertion in an authored (frozen) test file, and DECLARE it in "usageAssertion": ' +
  '{ "targetSymbols": [the artifact public symbols the consumer MUST exercise, e.g. "World.step", ' +
  '"resolve_collision"], "description": how the test asserts they are invoked }. Include ' +
  '"usageAssertion" whenever the goal is build-and-use; omit it only when it is not.\n' +
  '- Write any helper or test file INSIDE the workspace using a RELATIVE path; never reference an ' +
  'absolute or out-of-repo path such as /tmp.\n' +
  '- The rubric must be checkable by RUNNING that command. Do not author a rubric that judges ' +
  'runtime / visual / "is it meaningful" behavior a grader cannot execute — express those as ' +
  'assertions inside the test suite instead.\n' +
  '- If the verification needs dependencies installed (or any one-time prep) before it can run, put ' +
  'that in "setup" (e.g. "npm ci", "pip install -r requirements.txt", "go mod download") so the ' +
  'worker starts from a populated tree. Use the lockfile-respecting install for the repo\'s manifest. ' +
  'Omit "setup" when no preparation is needed.\n' +
  '- The "command" MUST be runnable OFFLINE — it runs every iteration and must not fetch from the ' +
  'network at verify time. Do all installing/fetching ONCE in "setup", then invoke the ' +
  'already-installed runner in the command. Concretely: do NOT use fetch-on-run forms like ' +
  '`npx --yes <pkg>` / `npx -y <pkg>`, `pip install ... && ...`, `go run <remote-url>`, or ' +
  '`uvx <pkg>` in the command — install the tool in "setup" (e.g. setup `npm install --no-save vitest`, ' +
  'command `npx --no-install vitest run ...` or `node ./node_modules/.bin/vitest run ...`; or simply ' +
  "use the repo's own `npm test` script). A verify command that depends on a live network is flaky by " +
  'construction and is the single most common cause of a run that cannot be evaluated.\n' +
  '- List in "requiredTools" the external programs the command and setup assume ALREADY exist on PATH ' +
  '— the language toolchain and test runner (e.g. ["cargo"], ["python","pytest"], ["go"], ' +
  '["node","npm"]). These are what goaly probes (and installs, or aborts on) before the loop; do NOT ' +
  'list shell builtins or coreutils. Omit when the command relies only on builtins.';

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
 * Fetch/install invocations that must NOT appear in the per-iteration verify COMMAND — they belong in
 * the one-time `setup` (which runs once before the loop). A verify command that fetches from the
 * network every iteration is flaky by construction: a transient registry/DNS hiccup turns a correct
 * tree into a could-not-evaluate run. Catching it at compile turns it into a typed COMPILE_FAILED the
 * bounded re-author loop (issue #51) self-corrects into an offline command — the enforcement half of
 * the "offline verify command" guardrail in the authoring prompt. This is a small, closed vocabulary
 * of install verbs matched at the START of each command segment (NOT a heuristic scrape of arbitrary
 * output), so a normal runner invocation (`npm test`, `vitest run`, `pytest`, `go test ./...`) passes
 * untouched. `npx <pkg>` is fine (it uses a locally-installed package); only the fetch-forcing
 * `npx --yes`/`-y`, `uvx`, and `pipx run` are flagged. Applied to LLM-authored `--generate` commands
 * only — a user's explicit `--verify-cmd` is their own informed choice (like the vacuous guard).
 */
export function referencesNetworkFetch(command: string): boolean {
  const FETCH_AT_RUN: readonly RegExp[] = [
    /^npx\s+(?:-y|--yes)\b/, // forces a registry fetch+install of the package
    /^uvx\b/, // always fetches the tool
    /^pipx\s+run\b/, // fetches+runs
    /^npm\s+(?:install|i|ci|add)\b/,
    /^pnpm\s+(?:install|i|add)\b/,
    /^yarn\s+(?:install|add)\b/,
    /^bun\s+(?:install|add|a)\b/,
    /^(?:pip|pip3)\s+install\b/,
    /^bundle\s+install\b/,
    /^go\s+mod\s+(?:download|tidy)\b/,
    /^cargo\s+(?:install|fetch)\b/,
  ];
  return command
    .split(/[\n;]|&&|\|\||\|/)
    .map((s) => s.trim())
    .some((segment) => FETCH_AT_RUN.some((re) => re.test(segment)));
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
    if (isTruncatedJson(raw)) {
      throw new Error(
        `AgentCompiler: LLM response was ${TRUNCATED_JSON_MARKER} (unbalanced braces) — it likely ran ` +
          'out of turns or output budget before finishing the JSON object.',
      );
    }
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
  /**
   * The provider session of the LAST authoring call, when the transport supports resume. A revise
   * round (compile-retry, Seal "revise", red-team re-author) then RESUMES it with only the feedback
   * as a delta turn — the model keeps its own prior reasoning and what it authored, instead of
   * re-receiving the whole authoring prompt amnesiac. Authoring-only continuity: the gates that
   * judge the output (usage gate, red-team, Seal, pre-flight, the two keys) all stay independent.
   * A fresh compile (no feedback — e.g. the next phase of a phased run) starts a NEW session.
   */
  #session: string | undefined;
  readonly #classifyShape:
    | ((goal: string, intent: string | undefined) => Promise<UsageShape>)
    | undefined;
  readonly #facts: WorkspaceFacts | undefined;

  constructor(opts: {
    llm: LlmProvider;
    writeFile?: (relPath: string, content: string) => Promise<void>;
    /** Preferred directory (relative to the repo root) for authored verification files (issue #52). */
    verifyDir?: string;
    /**
     * Independent goal-shape classifier for the anti-reimplementation usage gate. When provided (the
     * real runs wire it in `compose.ts`), a confident build-and-use goal must carry a runtime usage
     * assertion or the compile fails closed (→ COMPILE_FAILED, self-corrected by the compile-retry
     * loop). Left undefined the gate is skipped — unit tests opt in by injecting a stub, so the extra
     * LLM call never perturbs the scripted `FakeLlm` queues of the existing tests.
     */
    classifyShape?: (goal: string, intent: string | undefined) => Promise<UsageShape>;
    /**
     * Deterministic workspace facts (see {@link detectWorkspaceFacts}): injected into the authoring
     * prompt so a small model doesn't have to self-discover mechanical environment constraints
     * (module system, lockfile, manifests), and driving the pre-freeze module-format lint. Absent
     * (a non-code workspace, or tests) ⇒ no facts injected and no lint — nothing is ever assumed.
     */
    facts?: WorkspaceFacts;
  }) {
    this.#llm = opts.llm;
    this.#writeFile = opts.writeFile;
    this.#verifyDir = opts.verifyDir;
    this.#classifyShape = opts.classifyShape;
    this.#facts = opts.facts;
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
    if (this.#facts !== undefined) {
      // Deterministically detected, generically framed (with its own ignore-if-irrelevant clause):
      // a small model won't reliably self-discover the module system or lockfile, and an authored
      // file that can't LOAD kills the run at pre-flight instead of costing a compile-retry.
      guidanceParts.push(this.#facts.summary);
    }
    if (feedback !== undefined && feedback.length > 0) {
      guidanceParts.push(
        `Reviewer feedback on the previous contract attempt (revise accordingly): ${feedback}`,
      );
    }
    guidanceParts.push('Author verification as JSON only.');
    const fullPrompt = guidanceParts.join('\n');

    // A revise round resumes the compiler's OWN prior authoring session when the transport supports
    // it (see #session): the delta prompt carries only the feedback — the goal/rules/prior attempt
    // live in the resumed conversation, so the round costs a fraction of a full re-send. Falls back
    // to the fresh full-prompt call on any resume failure (a stale/rejected session must not burn a
    // compile-retry). The full prompt is ALWAYS what a fresh session receives — a delta to an
    // amnesiac model would be meaningless, hence the supportsResume gate.
    //
    // EXCEPTION: when the previous attempt was cut off mid-JSON (TRUNCATED_JSON_MARKER in the
    // feedback), do NOT resume — that session already ran out of turns/output budget once, and
    // resuming it tends to just re-hit the same ceiling with the same "explore first, answer last"
    // trajectory. Force a fresh session + the full prompt (which carries the stop-exploring guidance
    // via the feedback line above) instead.
    const wasTruncated = feedback !== undefined && feedback.includes(TRUNCATED_JSON_MARKER);
    const resumeId =
      feedback !== undefined &&
      feedback.length > 0 &&
      this.#llm.supportsResume === true &&
      !wasTruncated
        ? this.#session
        : undefined;
    const prompt =
      resumeId !== undefined
        ? `Reviewer feedback on your previous contract attempt (revise accordingly): ${feedback}\n` +
          'Re-emit the COMPLETE verification JSON object described at the start of this session — ' +
          'every field and the FULL content of every authored file, not a diff. JSON only.'
        : fullPrompt;

    let raw: string;
    let session: string | undefined;
    try {
      ({ text: raw, sessionId: session } = await this.#llm.complete({
        system: SYSTEM_PROMPT,
        prompt,
        temperature: 0,
        // A fresh authoring call asks for a goaly-MINTED session (an explicit id the provider
        // creates) so the session it later resumes contains ONLY this compiler's own turns — even
        // in environments that pin every bare CLI call to one ambient shared session.
        ...(resumeId !== undefined ? { resumeSessionId: resumeId } : { mintSession: true }),
      }));
    } catch (e) {
      if (resumeId !== undefined) {
        // Resume failed (stale session, CLI store evicted, …): retry once as a fresh full-prompt
        // call before surfacing anything — never trade a working revise round for the shortcut.
        this.#session = undefined;
        try {
          ({ text: raw, sessionId: session } = await this.#llm.complete({
            system: SYSTEM_PROMPT,
            prompt: fullPrompt,
            temperature: 0,
            mintSession: true,
          }));
        } catch (e2) {
          throw withTimeoutHint(e2);
        }
      } else {
        // A timed-out authoring call is still a fail-closed COMPILE_FAILED (invariant #4), but re-issuing
        // the same heavy call burns compile-retries on a transient infra limit, not a model mistake
        // (follow-on G: sonnet's 3× COMPILE_FAILED were LLM timeouts 10 min apart = the default
        // --llm-timeout-ms). Surface the cause + remedy so the user raises the timeout instead.
        throw withTimeoutHint(e);
      }
    }
    this.#session = session;

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

    if (referencesNetworkFetch(generated.command)) {
      throw new Error(
        `AgentCompiler: refusing a verification command that fetches/installs at verify time ` +
          `('${generated.command}') — it runs every iteration and a network hiccup would make a ` +
          'correct tree un-evaluable. Move the install into "setup" (runs once) and invoke the ' +
          'already-installed runner offline in the command (e.g. setup "npm install --no-save vitest", ' +
          'command "npx --no-install vitest run …" or "node ./node_modules/.bin/vitest run …"; or the ' +
          "repo's own \"npm test\").",
      );
    }

    // Deterministic module-format lint (small-model steering): an authored file that cannot even
    // LOAD under the detected Node module system (require() in an ESM package, import in a CJS one)
    // is a broken bar that would otherwise survive to pre-flight, where it kills the WHOLE run as
    // CONTRACT_UNSOUND — here it is one bounded compile-retry with the exact fix as feedback. Only
    // fires when a module system was actually DETECTED (a non-code workspace lints nothing).
    {
      const mismatch = findModuleFormatMismatch(
        generated.files ?? [],
        this.#facts?.nodeModuleSystem,
      );
      if (mismatch !== null) {
        throw new Error(
          `AgentCompiler: refusing to freeze a verification file that cannot load: ${mismatch.problem}.`,
        );
      }
    }

    // Anti-reimplementation usage gate: for a confident BUILD-AND-USE goal, the authored bar must carry
    // a runtime usage assertion embedded in a frozen file, or the worker could green the bar with a
    // parallel reimplementation that never touches the artifact. The classifier is independent (a
    // separate, neutral call over the goal) and fail-open; a violation throws → the Driver maps it to a
    // COMPILE_FAILED the bounded compile-retry loop re-authors with the assertion. Runs before writing
    // any file so a rejected contract leaves no partial files on disk (like the guards above).
    if (this.#classifyShape !== undefined) {
      const shape = await this.#classifyShape(config.goal, intent);
      enforceUsageAssertion({
        shape,
        usageAssertion: generated.usageAssertion,
        files: generated.files ?? [],
      });
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
