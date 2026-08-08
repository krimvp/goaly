import { z } from 'zod';
import type { AgentCli } from '../../agent-cli/registry';
import type { AutonomyLevel } from '../../agent-cli/droid-codec';
import { ModelSelection, type ModelSelectionInput } from '../models';
import { UsageError, str, type RawFlags } from './tokens';

/**
 * The harness (write-role coding agent): any bundled CLI, the IO-free `fake`, plus `goaly-code` — the
 * non-codec goaly-code harness that drives an OpenAI-compatible endpoint through goaly's own agent loop.
 */
export type HarnessChoice = AgentCli | 'fake' | 'goaly-code';

/** All valid harness choices — one source of truth for the flag parser and the resume adoption. */
export const HARNESS_CHOICES: readonly HarnessChoice[] = [
  'claude',
  'codex',
  'droid',
  'pi',
  'fake',
  'goaly-code',
];

/**
 * Harnesses shown to end users in help text and error hints. `fake` is deliberately omitted — it
 * is a test-only stub and selecting it outside a test context emits its own warning.
 */
export const PUBLIC_HARNESS_CHOICES: readonly HarnessChoice[] = [
  'claude',
  'codex',
  'droid',
  'pi',
  'goaly-code',
];

/** Whether a stored/untrusted string names a known harness. */
export function isHarnessChoice(value: string): value is HarnessChoice {
  return (HARNESS_CHOICES as readonly string[]).includes(value);
}

/**
 * Which provider runs the LLM workflow steps (judge / approver / compiler). Any bundled CLI, plus
 * `openai` — a direct OpenAI-compatible chat-completions endpoint (no coding CLI installed).
 */
export type LlmProviderChoice = AgentCli | 'openai';

/**
 * The default LLM provider for a harness: the workflow steps (compiler / judge / approver — the
 * steps that author a `--generate` bar and turn the two keys) FOLLOW the harness the user picked,
 * so `--harness codex` does not silently keep requiring the `claude` CLI to generate the
 * verification. `goaly-code` drives an OpenAI-compatible endpoint, so its steps default to the
 * `openai` provider on that same endpoint (its required `--base-url`/`--model` are exactly what
 * the provider needs); the test-only `fake` harness cannot back LLM steps and keeps `claude`.
 * An explicit `--llm-provider` (CLI flag or config file) always overrides.
 */
export function defaultLlmProvider(harness: HarnessChoice): LlmProviderChoice {
  if (harness === 'goaly-code') return 'openai';
  if (harness === 'fake') return 'claude';
  return harness;
}

export function parseHarness(value: string | undefined): HarnessChoice {
  if (value === undefined) return 'claude';
  if (isHarnessChoice(value)) {
    return value;
  }
  // The `claude-code` value was renamed to `claude` (one name per CLI across the harness and the
  // LLM-provider roles); fail closed with the migration hint rather than silently accept the old one.
  if (value === 'claude-code') {
    throw new UsageError(`unknown harness: claude-code (renamed — did you mean 'claude'?)`);
  }
  throw new UsageError(`unknown harness: ${value} (expected ${PUBLIC_HARNESS_CHOICES.join(' | ')})`);
}

/**
 * `--harness-autonomy low|medium|high` — how much the write-role CLI may do, for harnesses that gate
 * privileged actions behind a tier (today only droid's `--auto`). Absent ⇒ `undefined`, meaning
 * "keep the codec's own least-privilege default" (never a level chosen here), so the flag's absence
 * is byte-for-byte the historical behavior. Fails closed on anything else.
 */
export function parseHarnessAutonomy(value: string | undefined): AutonomyLevel | undefined {
  if (value === undefined) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new UsageError(`--harness-autonomy: expected low | medium | high, got '${value}'`);
}

export function parseLlmProvider(value: string | undefined, harness: HarnessChoice): LlmProviderChoice {
  if (value === undefined) return defaultLlmProvider(harness);
  if (value === 'claude' || value === 'codex' || value === 'droid' || value === 'pi' || value === 'openai') {
    return value;
  }
  throw new UsageError(`unknown llm provider: ${value} (expected claude | codex | droid | pi | openai)`);
}

/** Collect the model flags and validate them at the Zod seam (non-empty, fails closed). */
export function parseModels(flags: RawFlags): ModelSelection {
  const raw: Partial<Record<keyof ModelSelectionInput, string | string[]>> = {};
  const add = (key: keyof ModelSelectionInput, flag: string): void => {
    const v = str(flags, flag);
    if (v !== undefined) raw[key] = v;
  };
  add('model', 'model');
  add('llmModel', 'llm-model');
  add('judgeModel', 'judge-model');
  add('approverModel', 'approver-model');
  // Per-reviewer Sign-off models (follow-up to issue #84): a comma-separated LIST split into trimmed,
  // non-empty entries. The Zod array seam (.nonempty(), .min(1) per entry) is the real fail-closed
  // gate — splitting here just normalizes the wire form; an all-empty `--approver-models ,,` becomes
  // an empty array that the schema rejects.
  const approverModelsRaw = str(flags, 'approver-models');
  if (approverModelsRaw !== undefined) {
    raw.approverModels = approverModelsRaw.split(',').map((m) => m.trim());
  }
  add('compilerModel', 'compiler-model');
  add('plannerModel', 'planner-model');
  add('criticModel', 'critic-model');
  add('explainModel', 'explain-model');
  try {
    return ModelSelection.parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const issue = e.issues[0];
      const flag = issue?.path[0] !== undefined ? `--${String(issue.path[0])}` : 'a model flag';
      throw new UsageError(`${flag}: ${issue?.message ?? 'must be a non-empty value'}`);
    }
    throw e;
  }
}
