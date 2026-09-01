import type { LoadedConfig } from './config-file';
import { UsageError, str, type RawFlags } from './flags/tokens';
import { applyMode, parseMode } from './modes';
import { applyImpliedDefault, applyPreset, mergedPresets } from './presets';
import { MULTI_SOURCE_FIELDS } from './args-types';

/**
 * The flag LAYERING step of a `run`: config files < preset < mode profile < explicit CLI flags,
 * flattened into the one {@link RawFlags} overlay every downstream parser reads. Also the only
 * scope that still knows which layer a flag came from, so the provenance-dependent
 * `--verify-cmd | --generate` rule is judged here.
 */

/** Loads the config-file layer for a workspace (injectable so tests never touch the disk). */
export type ConfigLoader = (dir: string, explicit: string | undefined) => Promise<LoadedConfig>;

export type FlagLayers = {
  /** The merged flags: config overlay under the explicit CLI flags. */
  flags: RawFlags;
  /** Config files that supplied default flags, lowest-precedence first. */
  configSources: string[];
  /** Loud notes from the preset / mode expansions plus the `--generate` override warning. */
  warnings: string[];
};

/**
 * A config file (.goalyrc in --workspace/cwd, plus an explicit --config <path>) supplies DEFAULT
 * flags so the same wiring need not be repeated every run (issue #15). Explicit CLI flags always
 * win. For goal/intent/rubric the CLI source may be a *different* key than the config's (e.g.
 * --goal-file vs "goal"), so a config default for such a field is dropped whenever the CLI
 * provides ANY source for it — otherwise the two would look like a conflicting double-source.
 */
export async function resolveFlagLayers(
  cliFlags: RawFlags,
  load: ConfigLoader,
): Promise<FlagLayers> {
  const workspaceDir = str(cliFlags, 'workspace') ?? process.cwd();
  const loaded = await load(workspaceDir, str(cliFlags, 'config'));
  const configSources = loaded.sources;

  const preset = applyPresetLayer(loaded, { ...loaded.overlay }, cliFlags);
  let overlayFlags = preset.overlay;

  for (const field of MULTI_SOURCE_FIELDS) {
    if (cliFlags[field] !== undefined || cliFlags[`${field}-file`] !== undefined) {
      delete overlayFlags[field];
    }
  }

  // Autonomy profile (improvement plan 4.1): `--mode` (CLI or config) expands into explicit flag
  // values LAYERED config < profile < CLI, so everything downstream — including the frozen
  // RunConfig — sees ordinary flags. The expansion's loud notes land in `warnings` below.
  const mode = parseMode(str({ ...overlayFlags, ...cliFlags }, 'mode'));
  const modeNotes: string[] = [];
  if (mode !== undefined) {
    const expanded = applyMode(mode, overlayFlags, cliFlags);
    overlayFlags = expanded.overlay;
    modeNotes.push(...expanded.notes);
  }
  const flags: RawFlags = { ...overlayFlags, ...cliFlags };

  const warnings: string[] = [
    ...preset.notes,
    ...modeNotes,
    ...generateOverrideWarnings(cliFlags, overlayFlags, configSources),
  ];
  return { flags, configSources, warnings };
}

/**
 * Named preset (presets.ts): `--preset <name>` (or a persisted `"preset"` default) expands a
 * user-defined flag bundle from the config files' `presets` block into the config layer. It runs
 * BEFORE the multi-source drop (so a preset-supplied goal/intent/rubric obeys the same CLI-source
 * override rule) and BEFORE the mode expansion (so a preset's `mode` value is picked up exactly as
 * if typed). Layering: config base < preset < mode < explicit CLI flags.
 */
function applyPresetLayer(
  loaded: LoadedConfig,
  overlayFlags: RawFlags,
  cliFlags: RawFlags,
): { overlay: RawFlags; notes: string[] } {
  const requestedPreset = str({ ...overlayFlags, ...cliFlags }, 'preset');
  if (requestedPreset !== undefined) {
    return applyPreset(
      requestedPreset,
      str(cliFlags, 'preset') !== undefined,
      mergedPresets(loaded.presets),
      overlayFlags,
      cliFlags,
    );
  }
  if (str({ ...overlayFlags, ...cliFlags }, 'mode') === undefined) {
    // Neither a preset nor a mode was chosen: the 'default' preset applies IMPLICITLY, as the
    // weakest tier — it fills gaps only (config files and explicit flags always win), and its
    // `mode` is pre-expanded inside so the strong profile expansion never runs unasked.
    // `--preset none` (or a persisted `"preset": "none"`) opts out of even that.
    return applyImpliedDefault(mergedPresets(loaded.presets), overlayFlags, cliFlags);
  }
  return { overlay: overlayFlags, notes: [] };
}

/**
 * `--verify-cmd | --generate` is advertised as mutually exclusive in the usage synopsis, and
 * `cliInputToRunConfig` silently resolves it in favour of --generate. PROVENANCE decides which of
 * those two is right, and only this scope knows it (the config layer has already been flattened by
 * the time domain/config.ts sees the input):
 *   - both typed on the COMMAND LINE ⇒ a genuine contradiction the user must resolve (fail closed);
 *   - `verify-cmd` from a .goalyrc layer + --generate typed now ⇒ an ordinary, useful one-off
 *     override — keep --generate, but never silently: name the source that lost.
 */
function generateOverrideWarnings(
  cliFlags: RawFlags,
  overlayFlags: RawFlags,
  configSources: string[],
): string[] {
  if (cliFlags['generate'] !== undefined && cliFlags['verify-cmd'] !== undefined) {
    throw new UsageError(
      '--verify-cmd and --generate are mutually exclusive: --verify-cmd points at an EXISTING ' +
        'command, --generate has the agent AUTHOR one. Pass exactly one.',
    );
  }
  if (cliFlags['generate'] !== undefined && overlayFlags['verify-cmd'] !== undefined) {
    const from = configSources.length > 0 ? configSources.join(' / ') : 'the config file';
    return [
      `--generate overrides the 'verify-cmd' from ${from} ('${String(overlayFlags['verify-cmd'])}') — ` +
        'the verification will be AUTHORED, not the configured command.',
    ];
  }
  return [];
}
