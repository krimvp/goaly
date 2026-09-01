import { UsageError, type RawFlags } from './flags/tokens';
import { NO_PRESET, type LoadedPreset } from './config-file';
import { applyMode, parseMode } from './modes';

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

/**
 * The preset that applies WITHOUT being asked for: when a run chooses neither a preset nor a
 * mode, `default` is truly the default — `goaly "<goal>"` and `goaly --preset default "<goal>"`
 * are the same run. `--preset none` (or a persisted `"preset": "none"`) opts out.
 */
export const DEFAULT_PRESET = 'default';

/** The built-ins overlaid by the config layers' presets — what `--preset` actually resolves against. */
export function mergedPresets(
  configPresets: Record<string, LoadedPreset> | undefined,
): Record<string, LoadedPreset> {
  return { ...BUILTIN_PRESETS, ...(configPresets ?? {}) };
}

/**
 * Apply the {@link DEFAULT_PRESET} as the IMPLIED baseline of a run that chose neither a preset
 * nor a mode. Unlike an explicitly selected preset (which beats config base keys — it is the
 * user's most recent intent), the implied default is the weakest tier there is: it only FILLS
 * GAPS — any key already set by a config file or an explicit CLI flag wins, and a chosen `--mode`
 * or `--preset` suppresses it entirely (the caller guards that). So a project's persisted choices
 * are never stomped by a posture nobody asked for.
 *
 * To keep that gap-filling literal, a `mode` inside the default preset's body is expanded HERE
 * (into the same explicit flags `applyMode` would produce, body keys winning over the mode's
 * defaults) and each resulting flag is gap-filled individually — the strong mode expansion, which
 * deliberately beats config keys, never runs for an implied posture.
 *
 * Loud like everything else: the note names every flag the implied preset actually contributed
 * and the opt-outs; if the implied preset made the run autonomous with no independent approver
 * configured, the Sign-off independence reminder fires too.
 */
export function applyImpliedDefault(
  presets: Record<string, LoadedPreset>,
  configOverlay: RawFlags,
  cliFlags: RawFlags,
): AppliedPreset {
  const def = presets[DEFAULT_PRESET];
  if (def === undefined) return { overlay: { ...configOverlay }, notes: [] };

  // Expand the body's mode into plain flags; explicit body keys beat the mode's defaults.
  const expanded: RawFlags = { ...def.overlay };
  delete expanded['mode'];
  const bodyMode = def.overlay['mode'];
  if (bodyMode !== undefined) {
    const mode = parseMode(typeof bodyMode === 'string' ? bodyMode : String(bodyMode));
    if (mode !== undefined) {
      const profile = applyMode(mode, {}, {}).overlay;
      // A profile pins `candidates` to guard an EXPLICITLY chosen posture; the implied tier must
      // not inject it — a filled `candidates` masquerades as an operator choice, which would
      // silently defeat goal-directive delegation ("use 4 subagents") and conflict with a typed
      // `--best-of`. The tool default is 1 anyway; a redefined default's BODY may still set it.
      delete profile['candidates'];
      for (const [key, value] of Object.entries(profile)) {
        if (expanded[key] === undefined) expanded[key] = value;
      }
    }
  }

  const overlay: RawFlags = { ...configOverlay };
  const applied: string[] = [];
  for (const [key, value] of Object.entries(expanded)) {
    if (configOverlay[key] !== undefined || cliFlags[key] !== undefined) continue; // gaps only
    overlay[key] = value;
    applied.push(`${key}=${value === true ? 'on' : String(value)}`);
  }
  if (applied.length === 0) return { overlay, notes: [] };

  const notes = [
    `no --preset or --mode chosen — the '${DEFAULT_PRESET}' preset (${def.source}) fills the gaps: ` +
      `${applied.join(', ')} — pass --preset none for the bare tool defaults`,
  ];
  const merged = { ...overlay, ...cliFlags };
  // The reminder is about the RUN being unattended, not about who set the flag: a typed `-d` /
  // `--autonomous` on a bare run must not silence it (it used to — the implied preset no longer
  // "applied" autonomous, so the check keyed off the wrong fact).
  const autonomous = merged['autonomous'] !== undefined;
  if (
    autonomous &&
    merged['approver-model'] === undefined &&
    merged['approver-models'] === undefined
  ) {
    notes.push(
      `the implied '${DEFAULT_PRESET}' preset runs with no human at the gates — set ` +
        '--approver-model (or --approver-models) on a DIFFERENT model so the Sign-off key stays ' +
        'independent, or choose --mode review for a human Seal. Without one, goaly keeps the ' +
        "approver off the agent's --model where the provider allows it, and otherwise records the " +
        'run as SELF-JUDGED (degraded) in the run header, the end-of-run summary and `goaly runs show`',
    );
  }
  return { overlay, notes };
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
