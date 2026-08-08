import { UsageError, type RawFlags } from './flags/tokens';
import { NO_PRESET, type LoadedPreset } from './config-file';

/**
 * Named presets: user-defined flag bundles from the config files' `presets` block, selected with
 * `--preset <name>` — one word instead of N flags. Like `--mode` (modes.ts), a preset expands AT
 * PARSE TIME into the same explicit flag values a user could type by hand, so the reducer and the
 * frozen `RunConfig` see nothing new — no invisible state reaches the loop.
 *
 * Layering: config base keys < preset < `--mode` expansion < explicit CLI flags. A preset body may
 * itself set `mode`, so a preset is a superset of a mode (project wiring + an autonomy posture),
 * and the mode expansion that follows sees the preset's value exactly as if it were typed.
 *
 * Selection comes from `--preset` on the command line or a persisted top-level `"preset"` default —
 * the one spot where this feature could become invisible state, so a persisted default is always
 * announced with its off-switch (`--preset none`).
 */

export type AppliedPreset = { overlay: RawFlags; notes: string[] };

/** The source label for presets goaly itself defines (not read from any file). */
export const BUILTIN_PRESET_SOURCE = 'built-in';

/**
 * Presets goaly ships, so `--preset` works (and `goaly config presets` lists something to copy
 * from) before anyone has authored a config file. Exactly one, the most straightforward complete
 * way to run: `default` — hands-off autonomy, everything else left to the tool defaults.
 *
 * Built-in bodies are deliberately LANGUAGE- AND TOOLCHAIN-NEUTRAL: no `verify-cmd`, no
 * `setup-cmd`, no harness or model choice — verification falls back to the `--generate` default
 * (the LLM authors checks for whatever project it finds), so the preset works in any repo. A
 * test pins this. Any config layer may redefine a built-in name; the redefinition replaces it
 * wholesale, exactly like one config layer over another.
 */
export const BUILTIN_PRESETS: Readonly<Record<string, LoadedPreset>> = {
  default: { overlay: { mode: 'hands-off' }, source: BUILTIN_PRESET_SOURCE },
};

/** The built-ins overlaid by the config layers' presets — what `--preset` actually resolves against. */
export function mergedPresets(
  configPresets: Record<string, LoadedPreset> | undefined,
): Record<string, LoadedPreset> {
  return { ...BUILTIN_PRESETS, ...(configPresets ?? {}) };
}

/**
 * Expand the selected preset over the config-file overlay, respecting explicit CLI flags. Returns
 * the new config-layer overlay (CLI flags are spread on top by the caller, exactly as without a
 * preset) plus the loud notes: what the preset set and from which file, and every preset value an
 * explicit flag overrode. `--preset none` disables a persisted default for this invocation.
 * An unknown name fails closed listing what IS defined (invariant #6).
 */
export function applyPreset(
  requested: string,
  fromCli: boolean,
  presets: Record<string, LoadedPreset>,
  configOverlay: RawFlags,
  cliFlags: RawFlags,
): AppliedPreset {
  const provenance = fromCli ? '--preset' : `"preset" (a config-file default)`;

  if (requested === NO_PRESET) {
    const persisted = configOverlay['preset'];
    const notes =
      fromCli && typeof persisted === 'string' && persisted !== NO_PRESET
        ? [`--preset ${NO_PRESET}: the persisted default preset '${persisted}' is disabled for this run`]
        : [];
    return { overlay: { ...configOverlay }, notes };
  }

  const chosen = presets[requested];
  if (chosen === undefined) {
    const names = Object.keys(presets).sort();
    const available =
      names.length > 0
        ? `available: ${names.map((n) => `'${n}' (${presets[n]!.source})`).join(', ')}`
        : 'no presets are defined — add a "presets" block to .goalyrc, e.g. ' +
          `{ "presets": { "${requested}": { "mode": "hands-off" } } }`;
    throw new UsageError(`${provenance}: unknown preset '${requested}' (${available})`);
  }

  const notes: string[] = [];
  const overlay: RawFlags = { ...configOverlay };
  const applied: string[] = [];

  for (const [key, value] of Object.entries(chosen.overlay)) {
    if (cliFlags[key] !== undefined && cliFlags[key] !== value) {
      notes.push(
        `--${key} ${cliFlags[key] === true ? '' : String(cliFlags[key])} (explicit) overrides the ` +
          `preset '${requested}' value (${value === true ? 'on' : String(value)})`,
      );
      continue; // the CLI spread on top will win anyway; keep the overlay honest
    }
    overlay[key] = value;
    applied.push(`${key}=${value === true ? 'on' : String(value)}`);
  }

  notes.unshift(
    `preset '${requested}' (${chosen.source}): ${applied.length > 0 ? applied.join(', ') : 'fully overridden by explicit flags'}` +
      (fromCli ? '' : ` — persisted default; pass --preset ${NO_PRESET} to disable`),
  );
  return { overlay, notes };
}
