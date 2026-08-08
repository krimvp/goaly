import { describe, it, expect } from 'vitest';
import { applyPreset, mergedPresets, BUILTIN_PRESETS, BUILTIN_PRESET_SOURCE } from './presets';
import { parseArgs, UsageError } from './args';
import { defaultReaders } from './input-sources';
import type { LoadedConfig } from './config-file';

/**
 * Named presets. The unit half exercises the pure expansion; the parse-level half proves a preset
 * reaches the SAME frozen RunConfig explicit flags would, that the layering is config base <
 * preset < --mode < explicit CLI flags, and that every expansion (and its off-switch) is loud.
 */

const noConfig = async (): Promise<LoadedConfig> => ({ overlay: {}, sources: [] });
const withConfig =
  (overlay: LoadedConfig['overlay'], presets?: LoadedConfig['presets']): (() => Promise<LoadedConfig>) =>
  async () => ({ overlay, sources: ['.goalyrc'], ...(presets !== undefined ? { presets } : {}) });

const SHIP = { overlay: { mode: 'hands-off', 'budget-tokens': '500000' }, source: '.goalyrc' };
const QUICK = { overlay: { mode: 'review', 'max-iterations': '3' }, source: '~/.goalyrc' };

const run = ['run', '--goal', 'g', '--verify-cmd', 'true'];

describe('applyPreset', () => {
  it('merges the preset body over the config overlay and announces it with its source', () => {
    const { overlay, notes } = applyPreset('ship', true, { ship: SHIP }, { harness: 'codex' }, {});
    expect(overlay).toEqual({ harness: 'codex', mode: 'hands-off', 'budget-tokens': '500000' });
    expect(notes[0]).toContain("preset 'ship' (.goalyrc)");
    expect(notes[0]).toContain('mode=hands-off');
  });

  it('a preset value beats the same key in the config base layer', () => {
    const { overlay } = applyPreset('ship', true, { ship: SHIP }, { 'budget-tokens': '100' }, {});
    expect(overlay['budget-tokens']).toBe('500000');
  });

  it('an explicit CLI flag beats the preset value and is reported', () => {
    const { overlay, notes } = applyPreset(
      'ship',
      true,
      { ship: SHIP },
      {},
      { 'budget-tokens': '9000' },
    );
    expect(overlay['budget-tokens']).toBeUndefined(); // CLI wins via the spread on top
    expect(notes.some((n) => n.includes("--budget-tokens 9000 (explicit) overrides the preset 'ship'"))).toBe(true);
  });

  it('a persisted default carries the --preset none off-switch in its note', () => {
    const { notes } = applyPreset('ship', false, { ship: SHIP }, { preset: 'ship' }, {});
    expect(notes[0]).toContain('persisted default; pass --preset none to disable');
  });

  it('--preset none disables a persisted default, loudly, and changes nothing else', () => {
    const config = { preset: 'ship', harness: 'codex' };
    const { overlay, notes } = applyPreset('none', true, { ship: SHIP }, config, { preset: 'none' });
    expect(overlay).toEqual(config);
    expect(notes).toEqual(["--preset none: the persisted default preset 'ship' is disabled for this run"]);
  });

  it('--preset none with no persisted default is silent', () => {
    const { notes } = applyPreset('none', true, { ship: SHIP }, {}, { preset: 'none' });
    expect(notes).toEqual([]);
  });

  it('an unknown name fails closed listing what is defined, with sources', () => {
    expect(() => applyPreset('shp', true, { ship: SHIP, quick: QUICK }, {}, {})).toThrow(
      /unknown preset 'shp'.*'quick' \(~\/\.goalyrc\), 'ship' \(\.goalyrc\)/,
    );
  });

  it('with no presets defined at all, the error shows how to define one', () => {
    expect(() => applyPreset('ship', true, {}, {}, {})).toThrow(/no presets are defined.*"presets"/);
  });
});

describe('built-in presets', () => {
  it("ships exactly one straightforward built-in: 'default' = mode hands-off", () => {
    expect(BUILTIN_PRESETS).toEqual({
      default: { overlay: { mode: 'hands-off' }, source: BUILTIN_PRESET_SOURCE },
    });
  });

  it('built-in bodies are language- and toolchain-neutral (no project-specific wiring)', () => {
    // A built-in must work in ANY repo: no verification/setup commands (which encode a toolchain),
    // no harness/model/endpoint choice (which encode an installation). Verification falls back to
    // the --generate default, which fits any language.
    const projectSpecific = [
      'verify-cmd',
      'smoke',
      'setup-cmd',
      'goal',
      'intent',
      'rubric',
      'harness',
      'model',
      'llm-model',
      'llm-provider',
      'base-url',
      'sandbox-image',
    ];
    for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
      for (const key of projectSpecific) {
        expect(preset.overlay[key], `built-in '${name}' must not set '${key}'`).toBeUndefined();
      }
    }
  });

  it('a config layer redefining a built-in name replaces it wholesale', () => {
    const merged = mergedPresets({ default: { overlay: { mode: 'review' }, source: '.goalyrc' } });
    expect(merged['default']).toEqual({ overlay: { mode: 'review' }, source: '.goalyrc' });
  });

  it('config presets are added alongside the built-ins', () => {
    const merged = mergedPresets({ ship: SHIP });
    expect(Object.keys(merged).sort()).toEqual(['default', 'ship']);
  });
});

describe('parseArgs with --preset', () => {
  it('a preset reaches the same frozen RunConfig explicit flags would (via its mode too)', async () => {
    const a = await parseArgs(
      [...run, '--preset', 'ship'],
      defaultReaders,
      withConfig({}, { ship: SHIP }),
    );
    expect(a.config.autonomous).toBe(true); // via the preset's mode: hands-off
    expect(a.harnessAutonomy).toBe('medium');
    expect(a.config.budget.tokens).toBe(500000);
    expect(a.warnings.some((w) => w.includes("preset 'ship' (.goalyrc)"))).toBe(true);
  });

  it('layering: config base < preset < explicit CLI flag, each override loud', async () => {
    const a = await parseArgs(
      [...run, '--preset', 'ship', '--budget-tokens', '9000'],
      defaultReaders,
      withConfig({ 'budget-tokens': '100', harness: 'codex' }, { ship: SHIP }),
    );
    expect(a.config.budget.tokens).toBe(9000); // CLI beat the preset
    expect(a.harness).toBe('codex'); // config base keys the preset does not touch survive
    expect(a.warnings.some((w) => w.includes('(explicit) overrides the preset'))).toBe(true);
  });

  it('a persisted "preset" default applies without a flag and is announced with its off-switch', async () => {
    const a = await parseArgs(
      [...run],
      defaultReaders,
      withConfig({ preset: 'quick' }, { quick: QUICK }),
    );
    expect(a.config.maxIterations).toBe(3);
    expect(a.harnessAutonomy).toBe('low'); // via mode: review
    expect(a.warnings.some((w) => w.includes('pass --preset none to disable'))).toBe(true);
  });

  it('--preset none disables the persisted default for one invocation', async () => {
    const a = await parseArgs(
      [...run, '--preset', 'none'],
      defaultReaders,
      withConfig({ preset: 'quick' }, { quick: QUICK }),
    );
    expect(a.config.maxIterations).not.toBe(3);
    expect(a.warnings.some((w) => w.includes("default preset 'quick' is disabled"))).toBe(true);
  });

  it('a typed --preset wins over the persisted default', async () => {
    const a = await parseArgs(
      [...run, '--preset', 'ship'],
      defaultReaders,
      withConfig({ preset: 'quick' }, { quick: QUICK, ship: SHIP }),
    );
    expect(a.config.autonomous).toBe(true);
    expect(a.config.maxIterations).not.toBe(3);
  });

  it('a typed --mode still beats the mode a preset carries', async () => {
    const a = await parseArgs(
      [...run, '--preset', 'ship', '--mode', 'review'],
      defaultReaders,
      withConfig({}, { ship: SHIP }),
    );
    expect(a.config.autonomous).toBe(false); // review kept the human Seal
    expect(a.harnessAutonomy).toBe('low');
  });

  it("the built-in 'default' works with no config file at all", async () => {
    const a = await parseArgs([...run, '--preset', 'default'], defaultReaders, noConfig);
    expect(a.config.autonomous).toBe(true); // via the built-in's mode: hands-off
    expect(a.harnessAutonomy).toBe('medium');
    expect(a.warnings.some((w) => w.includes("preset 'default' (built-in)"))).toBe(true);
  });

  it("a config file redefining 'default' wins over the built-in", async () => {
    const a = await parseArgs(
      [...run, '--preset', 'default'],
      defaultReaders,
      withConfig({}, { default: { overlay: { mode: 'review' }, source: '.goalyrc' } }),
    );
    expect(a.config.autonomous).toBe(false);
    expect(a.harnessAutonomy).toBe('low');
    expect(a.warnings.some((w) => w.includes("preset 'default' (.goalyrc)"))).toBe(true);
  });

  it('an unknown preset fails closed, always listing at least the built-in', async () => {
    await expect(
      parseArgs([...run, '--preset', 'nope'], defaultReaders, withConfig({}, { ship: SHIP })),
    ).rejects.toThrow(UsageError);
    await expect(
      parseArgs([...run, '--preset', 'nope'], defaultReaders, noConfig),
    ).rejects.toThrow(/'default' \(built-in\)/);
  });

  it('a bare --preset fails closed (it expects a value)', async () => {
    await expect(parseArgs([...run, '--preset'], defaultReaders, noConfig)).rejects.toThrow(
      /--preset expects a value/,
    );
  });
});
