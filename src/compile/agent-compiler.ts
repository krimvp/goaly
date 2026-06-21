import { z } from 'zod';
import type { RunConfig } from '../domain/config';
import type { CompiledContract, Rung, UnhashedContract } from '../domain/contract';
import { freezeContract } from '../util/hash';
import type { LlmProvider } from '../llm/provider';
import type { VerifierCompiler } from './compiler';

/** Schema for the JSON the authoring LLM must emit (validated fail-closed). */
const GeneratedVerification = z.object({
  command: z.string().min(1),
  rubric: z.string(),
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
  '{ "command": string, "rubric": string, "files"?: Array<{ "path": string, "content": string }> }. ' +
  'The command must exit 0 exactly when the goal is achieved.';

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
 * Build the ladder for a given command + rubric. Always a deterministic rung first;
 * a judge rung is appended only when the rubric is a non-empty string.
 */
function buildRungs(
  command: string,
  rubric: string,
  judge: RunConfig['judge'],
): Rung[] {
  const rungs: Rung[] = [{ kind: 'deterministic', command }];
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

  constructor(opts: {
    llm: LlmProvider;
    writeFile?: (relPath: string, content: string) => Promise<void>;
  }) {
    this.#llm = opts.llm;
    this.#writeFile = opts.writeFile;
  }

  async compile(config: RunConfig): Promise<CompiledContract> {
    if (config.verifier.kind === 'existing') {
      return this.#compileExisting(config, config.verifier.ref);
    }
    return this.#compileGenerate(config, config.verifier.intent);
  }

  #compileExisting(config: RunConfig, ref: string): CompiledContract {
    const rubric = config.rubric ?? '';
    const unhashed: UnhashedContract = {
      goal: config.goal,
      rungs: buildRungs(ref, rubric, config.judge),
      rubric,
      generatedFiles: [],
    };
    return freezeContract(unhashed);
  }

  async #compileGenerate(
    config: RunConfig,
    intent: string | undefined,
  ): Promise<CompiledContract> {
    const guidanceParts = [`Goal: ${config.goal}`];
    if (intent !== undefined && intent.length > 0) {
      guidanceParts.push(`Intent: ${intent}`);
    }
    if (config.rubric !== undefined && config.rubric.length > 0) {
      guidanceParts.push(`Rubric guidance: ${config.rubric}`);
    }
    guidanceParts.push('Author verification as JSON only.');

    const raw = await this.#llm.complete({
      system: SYSTEM_PROMPT,
      prompt: guidanceParts.join('\n'),
      temperature: 0,
    });

    const generated = parseGenerated(raw);

    const generatedFiles: string[] = [];
    if (generated.files !== undefined && this.#writeFile !== undefined) {
      for (const file of generated.files) {
        await this.#writeFile(file.path, file.content);
        generatedFiles.push(file.path);
      }
    }

    const unhashed: UnhashedContract = {
      goal: config.goal,
      rungs: buildRungs(generated.command, generated.rubric, config.judge),
      rubric: generated.rubric,
      generatedFiles,
    };
    return freezeContract(unhashed);
  }
}
