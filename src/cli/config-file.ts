import { readFile as fsReadFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { errorMessage } from '../util/errors';
import { UsageError, type RawFlags } from './flags/tokens';

/**
 * Config-file support (issue #15): the SAME run wiring (harness, verifier, autonomous, budgets,
 * models, per-step timeouts, …) need not be repeated on every `goaly run`. A JSON file provides
 * DEFAULT flags that any explicit CLI flag overrides.
 *
 * Three sources, layered low→high precedence (each is optional except where noted):
 *   1. a home-level `~/.goalyrc` — a developer's personal defaults across every project,
 *   2. an implicit `.goalyrc` discovered in `--workspace` (or the cwd) — project defaults,
 *   3. an explicit `--config <path>` JSON file — when given it MUST exist (fails closed).
 * So the full resolution order is:
 *   tool default < `~/.goalyrc` < `<workspace>/.goalyrc` < `--config` file < CLI flag.
 * This is what makes `goaly "my goal"` enough: a one-time `~/.goalyrc` (e.g. `{ "autonomous":
 * true }`) carries the easy-mode wiring so only the goal need be typed.
 *
 * Keys mirror the CLI flag names in kebab-case (`max-iterations`, `verify-cmd`) — one spelling,
 * no aliases. This is an external seam: it parses with Zod and fails closed (invalid JSON, an
 * unknown key, or a non-primitive value is a usage error, never a silent ignore).
 *
 * A file may additionally carry a structural `presets` block — named bundles of the SAME flag
 * keys, selected per run with `--preset <name>` (or persistently via a top-level `"preset"`
 * default) — see {@link parseConfigDocument} and `presets.ts` for the expansion semantics.
 *
 * "Mirror the CLI flags" is a promise the `.strict()` schema below makes literal: an unlisted key is
 * a HARD usage error, so a flag missing from the schema cannot be persisted at all. The exclusions
 * are therefore a deliberate, enumerated set ({@link PER_INVOCATION_FLAGS}) rather than an accident
 * of what someone remembered to add — and `config-file.test.ts` enforces that by diffing the schema
 * against every flag the CLI documents.
 */

/** The implicit config file discovered in the workspace/cwd (and at the home level). JSON content. */
export const IMPLICIT_CONFIG_FILENAME = '.goalyrc';

/** Human-readable source label for the home-level config (the real path is `os.homedir()/.goalyrc`). */
export const HOME_CONFIG_LABEL = `~/${IMPLICIT_CONFIG_FILENAME}`;

/** A single config value: the JSON primitives a CLI flag can carry. */
const FlagValue = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Flags that are meaningful for ONE invocation only and so are deliberately NOT settable from a
 * config file. Three kinds:
 *   - run identity / targeting (`resume`, `from-run`, `inherit-session`, `workspace`, `worktree`,
 *     `config` itself) — persisting these would point every run in the tree at one prior run;
 *   - one-shot steering (`note`, `dry-run`) — a persisted `dry-run: true` would silently turn every
 *     run in the tree into a no-op;
 *   - alternate SOURCES for a value that already has a key (`goal-file` / `intent-file` /
 *     `rubric-file`, and the `defaults` alias for `autonomous`) — one spelling, no aliases.
 * Exported so the drift test can assert this is the complete difference between the CLI's documented
 * flags and the schema below.
 */
export const PER_INVOCATION_FLAGS: ReadonlySet<string> = new Set([
  'config',
  'defaults',
  'dry-run',
  'from-run',
  'goal-file',
  'inherit-session',
  'intent-file',
  'note',
  'resume',
  'rubric-file',
  'workspace',
  'worktree',
]);

/**
 * The accepted config shape — every CLI flag that makes sense to set repeatedly, keyed by its
 * kebab-case (flag-mirroring) name. `.strict()` rejects unknown keys so a typo fails loudly
 * instead of being silently dropped. The only omissions are {@link PER_INVOCATION_FLAGS}.
 */
const ConfigFileSchema = z
  .object({
    goal: FlagValue.optional(),
    'verify-cmd': FlagValue.optional(),
    generate: FlagValue.optional(),
    intent: FlagValue.optional(),
    rubric: FlagValue.optional(),
    autonomous: FlagValue.optional(),
    mode: FlagValue.optional(),
    preset: FlagValue.optional(),
    'max-iterations': FlagValue.optional(),
    candidates: FlagValue.optional(),
    'best-of': FlagValue.optional(),
    'resume-best-of-incomplete': FlagValue.optional(),
    phased: FlagValue.optional(),
    'max-phases': FlagValue.optional(),
    'max-plan-revisions': FlagValue.optional(),
    'max-plan-retries': FlagValue.optional(),
    'parallel-phases': FlagValue.optional(),
    'plan-file': FlagValue.optional(),
    'planner-model': FlagValue.optional(),
    'max-seal-revisions': FlagValue.optional(),
    'max-compile-retries': FlagValue.optional(),
    'verify-dir': FlagValue.optional(),
    smoke: FlagValue.optional(),
    'setup-cmd': FlagValue.optional(),
    'no-setup': FlagValue.optional(),
    'setup-timeout-ms': FlagValue.optional(),
    'install-missing-tools': FlagValue.optional(),
    'stuck-no-diff': FlagValue.optional(),
    'stuck-repeat-threshold': FlagValue.optional(),
    'stuck-oscillation': FlagValue.optional(),
    // The sharp one: goaly's own STUCK_HARNESS_CRASH remediation tells you to pass this on resume,
    // so being unable to persist it meant retyping it on every single resume.
    'stuck-crash-threshold': FlagValue.optional(),
    'stuck-unevaluable-threshold': FlagValue.optional(),
    'auto-remediate-stuck': FlagValue.optional(),
    'diff-ignore': FlagValue.optional(),
    baseline: FlagValue.optional(),
    'workspace-mode': FlagValue.optional(),
    'delta-verify': FlagValue.optional(),
    'cost-table': FlagValue.optional(),
    stream: FlagValue.optional(),
    'stream-transcript': FlagValue.optional(),
    'stream-file': FlagValue.optional(),
    explain: FlagValue.optional(),
    'explain-model': FlagValue.optional(),
    adversarial: FlagValue.optional(),
    'adversarial-plan-critics': FlagValue.optional(),
    'adversarial-contract-critics': FlagValue.optional(),
    'adversarial-refuters': FlagValue.optional(),
    'critic-model': FlagValue.optional(),
    'budget-tokens': FlagValue.optional(),
    'budget-wall-ms': FlagValue.optional(),
    'harness-timeout-ms': FlagValue.optional(),
    'harness-idle-timeout-ms': FlagValue.optional(),
    'llm-timeout-ms': FlagValue.optional(),
    'verify-timeout-ms': FlagValue.optional(),
    'max-agent-turns': FlagValue.optional(),
    harness: FlagValue.optional(),
    'harness-autonomy': FlagValue.optional(),
    'base-url': FlagValue.optional(),
    'llm-api-key-env': FlagValue.optional(),
    model: FlagValue.optional(),
    'llm-model': FlagValue.optional(),
    'judge-model': FlagValue.optional(),
    'approver-model': FlagValue.optional(),
    // Per-reviewer Sign-off models (follow-up to issue #84): a per-lens model LIST. Accept a JSON
    // ARRAY of strings (idiomatic for a list) OR a comma-separated string (the CLI wire form); both
    // normalize to the same comma-joined overlay value the CLI's `--approver-models` parser splits.
    'approver-models': z.union([z.array(z.string()), FlagValue]).optional(),
    'approver-quorum': FlagValue.optional(),
    'approver-diversity-temp': FlagValue.optional(),
    // User-overridable approver review lenses (issue #84 OQ4): like `approver-models`, accept a JSON
    // ARRAY of strings OR a comma-separated string; both normalize to the comma-joined overlay the
    // CLI's `--approver-lenses` parser splits (one parsing path).
    'approver-lenses': z.union([z.array(z.string()), FlagValue]).optional(),
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
 * Every key the config file accepts. Exported so the drift test can diff it against the flags the
 * CLI documents — the check that keeps "keys mirror the CLI flags" true as flags are added, rather
 * than something a reader discovers is false only when `.strict()` rejects their `.goalyrc`.
 */
export const CONFIG_FILE_KEYS: readonly string[] = Object.keys(ConfigFileSchema.shape);

/**
 * The `--preset none` sentinel: it disables a persisted default preset for one invocation, so no
 * preset may claim the name (fail-closed at parse, not a surprise at selection time).
 */
export const NO_PRESET = 'none';

/**
 * Named presets (the "one word instead of N flags" layer over `--mode`): a preset body is the SAME
 * flag-mirror object as the file's top level, minus `preset` itself (a preset selecting another
 * preset would be invisible chaining — exactly what parse-time expansion exists to avoid). It may
 * set `mode`, so a preset can bundle an autonomy profile with project wiring. Per-invocation flags
 * are excluded the same way they are at the top level (they are absent from the base schema).
 */
const PresetBodySchema = ConfigFileSchema.omit({ preset: true });

/** Preset names must survive `--preset <name>`, shell completion, and note text unquoted. */
const PRESET_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * The full config DOCUMENT: the flag-mirror top level plus the structural `presets` block. Still
 * `.strict()` — an unknown key anywhere (top level or inside a preset body) is a hard usage error.
 */
const ConfigDocumentSchema = ConfigFileSchema.extend({
  presets: z.record(z.string(), PresetBodySchema).optional(),
});

/** One parsed config document: the top-level flag overlay plus its named preset bodies. */
export type ParsedConfigDocument = {
  overlay: RawFlags;
  presets: Record<string, RawFlags>;
};

/** Normalize one flag-mirror object (top level or a preset body) into a {@link RawFlags} overlay. */
function normalizeOverlay(parsed: z.infer<typeof ConfigFileSchema>): RawFlags {
  const overlay: RawFlags = {};
  for (const [flag, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      if (value) overlay[flag] = true; // false → omit (matches CLI flag-absence semantics)
      continue;
    }
    // A LIST value (e.g. `approver-models`) is joined into the comma-separated wire form so it flows
    // through the SAME `--flag a,b` parser the CLI uses (one parsing path, no special-casing here).
    if (Array.isArray(value)) {
      overlay[flag] = value.join(',');
      continue;
    }
    overlay[flag] = typeof value === 'number' ? String(value) : value;
  }
  return overlay;
}

/**
 * Validate a parsed JSON config document and normalize it: the top level into a {@link RawFlags}
 * overlay keyed by the canonical (kebab-case) CLI flag names — so the same parsing/coercion path
 * the CLI already uses validates every value downstream — and each `presets` body into the same
 * overlay shape. Fails closed (UsageError) on a bad shape anywhere, a malformed preset name, or a
 * preset named `none` (reserved for `--preset none`).
 *
 * Booleans are presence-style, exactly like the CLI: `true` sets the flag, `false` is treated as
 * "not set" (the flag's absence is its default), so a config can't be the only place a boolean is
 * forced off. Numbers are stringified so they flow through the same `z.coerce` seam as `--flag N`.
 */
export function parseConfigDocument(raw: unknown, source: string): ParsedConfigDocument {
  let parsed: z.infer<typeof ConfigDocumentSchema>;
  try {
    parsed = ConfigDocumentSchema.parse(raw);
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

  const { presets: presetBodies, ...flagEntries } = parsed;
  const presets: Record<string, RawFlags> = {};
  for (const [name, body] of Object.entries(presetBodies ?? {})) {
    if (name === NO_PRESET) {
      throw new UsageError(
        `config file '${source}': preset name '${NO_PRESET}' is reserved (--preset ${NO_PRESET} disables a persisted default)`,
      );
    }
    if (!PRESET_NAME_RE.test(name)) {
      throw new UsageError(
        `config file '${source}': invalid preset name '${name}' (use letters, digits, '-', '_'; must start with a letter or digit)`,
      );
    }
    presets[name] = normalizeOverlay(body);
  }
  return { overlay: normalizeOverlay(flagEntries), presets };
}

/** The top-level flag overlay of a config document (kept for callers that write no presets). */
export function overlayFromConfig(raw: unknown, source: string): RawFlags {
  return parseConfigDocument(raw, source).overlay;
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

/** A named preset as loaded: its flag overlay plus the config file that defined it (for the loud note). */
export type LoadedPreset = { overlay: RawFlags; source: string };

export type LoadedConfig = {
  /** Normalized flag overlay (empty when no config file contributed). */
  overlay: RawFlags;
  /** Files that supplied defaults, lowest-precedence first (for logging). Empty when none. */
  sources: string[];
  /**
   * Named presets across all layers. A later layer that redefines a name replaces it WHOLESALE (no
   * cross-file body merging — "the nearest definition wins" is one debuggable sentence). Optional
   * so hand-built fixtures without presets stay valid; absent ⇒ none defined.
   */
  presets?: Record<string, LoadedPreset>;
};

/** Parse one config file's text into a document, failing closed on bad JSON or a bad shape. */
function documentFromText(text: string, source: string): ParsedConfigDocument {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`config file '${source}' is not valid JSON: ${errorMessage(e)}`);
  }
  return parseConfigDocument(json, source);
}

/**
 * Load the layered config overlay: a home-level `~/.goalyrc` (lowest precedence) overlaid by the
 * implicit {@link IMPLICIT_CONFIG_FILENAME} in `dir`, overlaid by an explicit `--config <path>`
 * file (if given — a missing explicit path is a usage error). Returns an empty overlay when none
 * exist. These reads are the ONLY filesystem access here; everything downstream sees a plain
 * {@link RawFlags} overlay. `homeDir` is injectable so tests stay deterministic without depending
 * on the runner's real home.
 */
export async function loadConfig(
  dir: string,
  explicitPath: string | undefined,
  read: ConfigFileReader = defaultConfigFileReader,
  homeDir: string = os.homedir(),
): Promise<LoadedConfig> {
  const overlay: RawFlags = {};
  const sources: string[] = [];
  const presets: Record<string, LoadedPreset> = {};

  const applyLayer = (text: string, label: string): void => {
    const doc = documentFromText(text, label);
    Object.assign(overlay, doc.overlay);
    for (const [name, body] of Object.entries(doc.presets)) {
      presets[name] = { overlay: body, source: label }; // wholesale replacement, never a body merge
    }
    sources.push(label);
  };

  const homePath = path.join(homeDir, IMPLICIT_CONFIG_FILENAME);
  const workspacePath = path.join(dir, IMPLICIT_CONFIG_FILENAME);
  // When the cwd IS the home dir the two implicit files are the same on disk — read/apply/list it
  // once (as the workspace file) so a single `~/.goalyrc` doesn't get layered onto itself.
  const homeIsWorkspace = path.resolve(homePath) === path.resolve(workspacePath);

  // 1. Home-level `~/.goalyrc` (optional, lowest precedence — personal cross-project defaults).
  if (!homeIsWorkspace) {
    const home = await read(homePath);
    if (home !== undefined) applyLayer(home, HOME_CONFIG_LABEL);
  }

  // 2. Implicit workspace/cwd `.goalyrc` (optional — overrides the home file on conflicts).
  const implicit = await read(workspacePath);
  if (implicit !== undefined) applyLayer(implicit, IMPLICIT_CONFIG_FILENAME);

  // 3. Explicit `--config <path>` (required to exist; overrides the implicit files on conflicts).
  if (explicitPath !== undefined) {
    const text = await read(explicitPath);
    if (text === undefined) {
      throw new UsageError(`config file '${explicitPath}' (from --config) does not exist`);
    }
    applyLayer(text, explicitPath);
  }

  return { overlay, sources, ...(Object.keys(presets).length > 0 ? { presets } : {}) };
}
