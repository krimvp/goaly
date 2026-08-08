import { describe, it, expect } from 'vitest';
import { parseMode, applyMode, MODE_NAMES } from './modes';
import { parseArgs, UsageError } from './args';
import { defaultReaders } from './input-sources';
import type { LoadedConfig } from './config-file';

/**
 * Autonomy profiles (improvement plan 4.1). The unit half exercises the pure expansion; the
 * parse-level half proves a profile reaches the SAME frozen RunConfig explicit flags would — and
 * that explicit flags beat the profile, loudly.
 */

const noConfig = async (): Promise<LoadedConfig> => ({ overlay: {}, sources: [] });
const withConfig =
  (overlay: LoadedConfig['overlay']): (() => Promise<LoadedConfig>) =>
  async () => ({ overlay, sources: ['.goalyrc'] });

const run = ['run', '--goal', 'g', '--verify-cmd', 'true'];

describe('parseMode', () => {
  it('accepts each profile name and fails closed otherwise', () => {
    for (const name of MODE_NAMES) expect(parseMode(name)).toBe(name);
    expect(parseMode(undefined)).toBeUndefined();
    expect(() => parseMode('yolo')).toThrow(UsageError);
  });
});

describe('applyMode', () => {
  it('review drops hands-off keys from the config layer, with a note each', () => {
    const { overlay, notes } = applyMode('review', { autonomous: true, candidates: '4' }, {});
    expect(overlay['autonomous']).toBeUndefined();
    expect(overlay['candidates']).toBeUndefined();
    expect(overlay['harness-autonomy']).toBe('low');
    expect(notes.some((n) => n.includes("dropping config-file 'autonomous'"))).toBe(true);
  });

  it('an explicit CLI flag beats the profile default and is reported', () => {
    const { overlay, notes } = applyMode('hands-off', {}, { 'harness-autonomy': 'low' });
    expect(overlay['harness-autonomy']).toBeUndefined(); // CLI wins via the spread on top
    expect(notes.some((n) => n.includes('--harness-autonomy low (explicit) overrides'))).toBe(true);
  });

  it('hands-off without an approver model carries the independence reminder', () => {
    const { notes } = applyMode('hands-off', {}, {});
    expect(notes.some((n) => n.includes('--approver-model'))).toBe(true);
    const quiet = applyMode('hands-off', {}, { 'approver-model': 'other' });
    expect(quiet.notes.some((n) => n.includes('Sign-off key stays independent'))).toBe(false);
  });
});

describe('parseArgs with --mode', () => {
  it('hands-off expands to autonomous + medium autonomy + delta-verify + 1 candidate', async () => {
    const a = await parseArgs([...run, '--mode', 'hands-off'], defaultReaders, noConfig);
    expect(a.config.autonomous).toBe(true);
    expect(a.harnessAutonomy).toBe('medium');
    expect(a.config.deltaVerify).toBe(true);
    expect(a.config.candidates).toBe(1);
    expect(a.warnings.some((w) => w.includes('--approver-model'))).toBe(true);
  });

  it('aggressive expands to autonomous + high autonomy + adversarial + 3 candidates + auto-remediation', async () => {
    const a = await parseArgs([...run, '--mode', 'aggressive'], defaultReaders, noConfig);
    expect(a.config.autonomous).toBe(true);
    expect(a.harnessAutonomy).toBe('high');
    expect(a.config.adversarial.enabled).toBe(true);
    expect(a.config.candidates).toBe(3);
    expect(a.config.stuckPolicy.autoRemediate).toBe(true);
  });

  it('review keeps the human Seal even against a config-file autonomous:true', async () => {
    const a = await parseArgs(
      [...run, '--mode', 'review'],
      defaultReaders,
      withConfig({ autonomous: true, candidates: '4' }),
    );
    expect(a.config.autonomous).toBe(false);
    expect(a.config.candidates).toBe(1);
    expect(a.harnessAutonomy).toBe('low');
    expect(a.warnings.some((w) => w.includes('dropping config-file'))).toBe(true);
  });

  it('an explicit flag overrides the profile and logs the override', async () => {
    const a = await parseArgs(
      [...run, '--mode', 'hands-off', '--harness-autonomy', 'low'],
      defaultReaders,
      noConfig,
    );
    expect(a.harnessAutonomy).toBe('low');
    expect(a.warnings.some((w) => w.includes('overrides the --mode hands-off default'))).toBe(true);
  });

  it('mode can come from the config file, and a typed --mode wins over it', async () => {
    const fromConfig = await parseArgs([...run], defaultReaders, withConfig({ mode: 'hands-off' }));
    expect(fromConfig.config.autonomous).toBe(true);

    const overridden = await parseArgs(
      [...run, '--mode', 'review'],
      defaultReaders,
      withConfig({ mode: 'hands-off' }),
    );
    expect(overridden.config.autonomous).toBe(false);
  });

  it('an unknown mode fails closed', async () => {
    await expect(parseArgs([...run, '--mode', 'yolo'], defaultReaders, noConfig)).rejects.toThrow(
      UsageError,
    );
  });
});
