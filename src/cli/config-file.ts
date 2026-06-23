import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../util/errors';
import { UsageError, type RawFlags } from './args';

/**
 * Config-file support (issue #15): the SAME run wiring (harness, verifier, autonomous, budgets,
 * models, per-step timeouts, …) need not be repeated on every `goaly run`. A JSON file provides
 * DEFAULT flags that any explicit CLI flag overrides.
 *
 * Two sources, layered low→high precedence (v1 keeps this deliberately small):
 *   1. an implicit `.goalyrc` discovered in `--workspace` (or the cwd) — absent is fine,
 *   2. an explicit `--config <path>` JSON file — when given it MUST exist (fails closed).
 * So the full resolution order is: tool default < `.goalyrc` < `--config` file < CLI flag.
 *
 * Keys mirror the CLI flag names in kebab-case (`max-iterations`, `verify-cmd`) — one spelling,
 * no aliases. This is an external seam: it parses with Zod and fails closed (invalid JSON, an
 * unknown key, or a non-primitive value is a usage error, never a silent ignore).
 */

/** The implicit config file discovered in the workspace/cwd. JSON content. */
export const IMPLICIT_CONFIG_FILENAME = '.goalyrc';

/** A single config value: the JSON primitives a CLI flag can carry. */
const FlagValue = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The accepted config shape — every CLI flag that makes sense to set repeatedly, keyed by its
 * kebab-case (flag-mirroring) name. `.strict()` rejects unknown keys so a typo fails loudly
 * instead of being silently dropped. Per-invocation flags (`--resume`, `--workspace`, `--config`)
 * are intentionally absent — they don't belong in shared, repeated config.
 */
const ConfigFileSchema = z
  .object({
    goal: FlagValue.optional(),
    'verify-cmd': FlagValue.optional(),
    generate: FlagValue.optional(),
    intent: FlagValue.optional(),
    rubric: FlagValue.optional(),
    autonomous: FlagValue.optional(),
    'max-iterations': FlagValue.optional(),
    'max-gate-a-revisions': FlagValue.optional(),
    'max-compile-retries': FlagValue.optional(),
    'verify-dir': FlagValue.optional(),
    smoke: FlagValue.optional(),
    'stuck-no-diff': FlagValue.optional(),
    'stuck-repeat-threshold': FlagValue.optional(),
    'stuck-oscillation': FlagValue.optional(),
    'budget-tokens': FlagValue.optional(),
    'budget-wall-ms': FlagValue.optional(),
    'harness-timeout-ms': FlagValue.optional(),
    'harness-idle-timeout-ms': FlagValue.optional(),
    'llm-timeout-ms': FlagValue.optional(),
    'verify-timeout-ms': FlagValue.optional(),
    harness: FlagValue.optional(),
    model: FlagValue.optional(),
    'llm-model': FlagValue.optional(),
    'judge-model': FlagValue.optional(),
    'approver-model': FlagValue.optional(),
    'compiler-model': FlagValue.optional(),
    'llm-provider': FlagValue.optional(),
    'log-level': FlagValue.optional(),
    'log-file': FlagValue.optional(),
    'no-log-file': FlagValue.optional(),
    sandbox: FlagValue.optional(),
    'sandbox-net': FlagValue.optional(),
    'sandbox-image': FlagValue.optional(),
    'sandbox-runtime': FlagValue.optional(),
  })
  .strict();

/**
 * Validate a parsed JSON config and normalize it into a {@link RawFlags} overlay keyed by the
 * canonical (kebab-case) CLI flag names — so the same parsing/coercion path the CLI already uses
 * validates every value downstream. Fails closed (UsageError) on a bad shape.
 *
 * Booleans are presence-style, exactly like the CLI: `true` sets the flag, `false` is treated as
 * "not set" (the flag's absence is its default), so a config can't be the only place a boolean is
 * forced off. Numbers are stringified so they flow through the same `z.coerce` seam as `--flag N`.
 */
export function overlayFromConfig(raw: unknown, source: string): RawFlags {
  let parsed: z.infer<typeof ConfigFileSchema>;
  try {
    parsed = ConfigFileSchema.parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const issue = e.issues[0];
      const at = issue?.path.length ? ` at key '${issue.path.join('.')}'` : '';
      throw new UsageError(
        `config file '${source}' is invalid${at}: ${issue?.message ?? 'expected a JSON object of flag values'}`,
      );
    }
    throw e;
  }

  const overlay: RawFlags = {};
  for (const [flag, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      if (value) overlay[flag] = true; // false → omit (matches CLI flag-absence semantics)
      continue;
    }
    overlay[flag] = typeof value === 'number' ? String(value) : value;
  }
  return overlay;
}

/** Reads a config file's text, or `undefined` if it does not exist. Injectable for tests. */
export type ConfigFileReader = (filePath: string) => Promise<string | undefined>;

/** Production reader: the filesystem. A missing file is `undefined`; any other IO error fails closed. */
export const defaultConfigFileReader: ConfigFileReader = async (filePath) => {
  try {
    return await fsReadFile(filePath, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw new UsageError(`could not read config file '${filePath}': ${errorMessage(e)}`);
  }
};

function isNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'ENOENT'
  );
}

export type LoadedConfig = {
  /** Normalized flag overlay (empty when no config file contributed). */
  overlay: RawFlags;
  /** Files that supplied defaults, lowest-precedence first (for logging). Empty when none. */
  sources: string[];
};

/** Parse one config file's text into an overlay, failing closed on bad JSON or a bad shape. */
function overlayFromText(text: string, source: string): RawFlags {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`config file '${source}' is not valid JSON: ${errorMessage(e)}`);
  }
  return overlayFromConfig(json, source);
}

/**
 * Load the layered config overlay: the implicit {@link IMPLICIT_CONFIG_FILENAME} in `dir` (if
 * present) overlaid by an explicit `--config <path>` file (if given — a missing explicit path is a
 * usage error). Returns an empty overlay when neither exists. These two reads are the ONLY
 * filesystem access here; everything downstream sees a plain {@link RawFlags} overlay.
 */
export async function loadConfig(
  dir: string,
  explicitPath: string | undefined,
  read: ConfigFileReader = defaultConfigFileReader,
): Promise<LoadedConfig> {
  const overlay: RawFlags = {};
  const sources: string[] = [];

  // 1. Implicit `.goalyrc` (optional — absent is fine, it's only a source of defaults).
  const implicit = await read(path.join(dir, IMPLICIT_CONFIG_FILENAME));
  if (implicit !== undefined) {
    Object.assign(overlay, overlayFromText(implicit, IMPLICIT_CONFIG_FILENAME));
    sources.push(IMPLICIT_CONFIG_FILENAME);
  }

  // 2. Explicit `--config <path>` (required to exist; overrides the implicit file on conflicts).
  if (explicitPath !== undefined) {
    const text = await read(explicitPath);
    if (text === undefined) {
      throw new UsageError(`config file '${explicitPath}' (from --config) does not exist`);
    }
    Object.assign(overlay, overlayFromText(text, explicitPath));
    sources.push(explicitPath);
  }

  return { overlay, sources };
}
