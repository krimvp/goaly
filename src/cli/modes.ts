import { UsageError, type RawFlags } from './flags/tokens';

/**
 * Autonomy profiles (improvement plan 4.1): `--mode review|hands-off|aggressive` expands AT PARSE
 * TIME into the same explicit flag values a user could type by hand, so the reducer and the frozen
 * `RunConfig` see nothing new — no invisible state reaches the loop.
 *
 * Layering: config files < profile < explicit CLI flags. A profile you name on the command line
 * beats persisted `.goalyrc` defaults (it is your most recent intent), and any flag you ALSO type
 * beats the profile — each such override is reported loudly in the parse warnings.
 *
 * `review` additionally CLEARS the hands-off keys a config file may carry (`autonomous`,
 * `adversarial`, `candidates`, …): its whole point is a human at every gate, and a persisted
 * `autonomous: true` silently defeating it would be exactly the kind of invisible state this
 * feature exists to avoid.
 */

export type ModeName = 'review' | 'hands-off' | 'aggressive';

export const MODE_NAMES: readonly ModeName[] = ['review', 'hands-off', 'aggressive'];

type ModeSpec = {
  /** Profile defaults, exactly as the CLI flags would spell them. */
  readonly set: Readonly<RawFlags>;
  /** Keys REMOVED from the config-file layer (never from explicit CLI flags). */
  readonly clear: readonly string[];
};

const MODES: Record<ModeName, ModeSpec> = {
  review: {
    set: { 'harness-autonomy': 'low' },
    clear: ['autonomous', 'adversarial', 'candidates', 'best-of', 'parallel-phases'],
  },
  'hands-off': {
    set: {
      autonomous: true,
      'harness-autonomy': 'medium',
      'delta-verify': true,
      candidates: '1',
    },
    clear: [],
  },
  aggressive: {
    set: {
      autonomous: true,
      'harness-autonomy': 'high',
      adversarial: true,
      candidates: '3',
      'auto-remediate-stuck': 'true',
    },
    clear: [],
  },
};

/** Validate `--mode` at the seam, fail-closed (invariant #6). Absent ⇒ undefined (no profile). */
export function parseMode(value: string | undefined): ModeName | undefined {
  if (value === undefined) return undefined;
  if ((MODE_NAMES as readonly string[]).includes(value)) return value as ModeName;
  throw new UsageError(`--mode: expected ${MODE_NAMES.join(' | ')}, got '${value}'`);
}

/**
 * Expand a profile over the config-file overlay, respecting explicit CLI flags. Returns the new
 * config-layer overlay (CLI flags are spread on top by the caller, exactly as without a mode) plus
 * the loud notes: every cleared config key, every profile default an explicit flag overrode, and
 * the hands-off independence reminder.
 */
export function applyMode(
  mode: ModeName,
  configOverlay: RawFlags,
  cliFlags: RawFlags,
): { overlay: RawFlags; notes: string[] } {
  const spec = MODES[mode];
  const notes: string[] = [];
  const overlay: RawFlags = { ...configOverlay };

  for (const key of spec.clear) {
    if (overlay[key] !== undefined) {
      delete overlay[key];
      notes.push(`--mode ${mode}: dropping config-file '${key}' (${mode} keeps a human at the gates)`);
    }
  }

  for (const [key, value] of Object.entries(spec.set)) {
    if (cliFlags[key] !== undefined && cliFlags[key] !== value) {
      notes.push(
        `--${key} ${cliFlags[key] === true ? '' : String(cliFlags[key])} (explicit) overrides the ` +
          `--mode ${mode} default (${value === true ? 'on' : String(value)})`,
      );
      continue; // the CLI spread on top will win anyway; keep the overlay honest
    }
    overlay[key] = value;
  }

  // hands-off is fully autonomous: without a separately-chosen approver model the second key
  // collapses onto the first (the composition-time independence warnings elaborate).
  const merged = { ...overlay, ...cliFlags };
  if (mode === 'hands-off' && merged['approver-model'] === undefined && merged['approver-models'] === undefined) {
    notes.push(
      '--mode hands-off runs with no human at the gates — set --approver-model (or --approver-models) ' +
        'on a DIFFERENT model so the Sign-off key stays independent',
    );
  }

  return { overlay, notes };
}
