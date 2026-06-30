import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  overlayFromConfig,
  defaultConfigFileReader,
  IMPLICIT_CONFIG_FILENAME,
  HOME_CONFIG_LABEL,
  type ConfigFileReader,
} from './config-file';
import { UsageError } from './args';

/** A reader backed by an in-memory map keyed by full path; missing files are `undefined`. */
function fakeReader(files: Record<string, string>): ConfigFileReader {
  return async (p) => files[p];
}

describe('overlayFromConfig', () => {
  it('normalizes kebab-case keys to a flag overlay', () => {
    const overlay = overlayFromConfig(
      { harness: 'fake', autonomous: true, 'max-iterations': 1, 'verify-cmd': 'npm test' },
      '.goalyrc',
    );
    expect(overlay).toEqual({
      harness: 'fake',
      autonomous: true,
      'max-iterations': '1',
      'verify-cmd': 'npm test',
    });
  });

  it('accepts the per-step timeout keys', () => {
    const overlay = overlayFromConfig(
      { 'harness-timeout-ms': 120000, 'llm-timeout-ms': 90000, 'verify-timeout-ms': 30000 },
      '.goalyrc',
    );
    expect(overlay).toEqual({
      'harness-timeout-ms': '120000',
      'llm-timeout-ms': '90000',
      'verify-timeout-ms': '30000',
    });
  });

  it('treats a false boolean as "not set" (matches CLI flag-absence semantics)', () => {
    const overlay = overlayFromConfig({ autonomous: false, generate: true }, '.goalyrc');
    expect(overlay).toEqual({ generate: true });
    expect('autonomous' in overlay).toBe(false);
  });

  it('stringifies numbers so they flow through the CLI coercion seam', () => {
    const overlay = overlayFromConfig({ 'budget-tokens': 500000, 'max-seal-revisions': 0 }, '.goalyrc');
    expect(overlay).toEqual({ 'budget-tokens': '500000', 'max-seal-revisions': '0' });
  });

  it('accepts the approver panel keys (issue #84)', () => {
    const overlay = overlayFromConfig(
      { 'approver-quorum': 3, 'approver-diversity-temp': 0.7 },
      '.goalyrc',
    );
    expect(overlay).toEqual({ 'approver-quorum': '3', 'approver-diversity-temp': '0.7' });
  });

  it('joins an --approver-lenses array into the comma wire form (issue #84 OQ4)', () => {
    const overlay = overlayFromConfig(
      { 'approver-lenses': ['CORRECTNESS', 'SECURITY'] },
      '.goalyrc',
    );
    expect(overlay).toEqual({ 'approver-lenses': 'CORRECTNESS,SECURITY' });
  });

  it('also accepts --approver-lenses as a comma-separated string (issue #84 OQ4)', () => {
    const overlay = overlayFromConfig({ 'approver-lenses': 'CORRECTNESS,SECURITY' }, '.goalyrc');
    expect(overlay).toEqual({ 'approver-lenses': 'CORRECTNESS,SECURITY' });
  });

  it('rejects an unknown key (fails closed)', () => {
    expect(() => overlayFromConfig({ bogus: 'x' }, '.goalyrc')).toThrow(UsageError);
  });

  it('rejects a camelCase key (v1 mirrors the flag names in kebab-case only)', () => {
    expect(() => overlayFromConfig({ maxIterations: 2 }, '.goalyrc')).toThrow(UsageError);
  });

  it('rejects a non-object config', () => {
    expect(() => overlayFromConfig([1, 2, 3], '.goalyrc')).toThrow(UsageError);
    expect(() => overlayFromConfig('nope', '.goalyrc')).toThrow(UsageError);
  });

  it('rejects a non-primitive value', () => {
    expect(() => overlayFromConfig({ harness: { nested: true } }, '.goalyrc')).toThrow(UsageError);
  });
});

describe('loadConfig', () => {
  it('returns an empty overlay when neither .goalyrc nor --config exists', async () => {
    const loaded = await loadConfig('/some/dir', undefined, fakeReader({}));
    expect(loaded).toEqual({ overlay: {}, sources: [] });
  });

  it('loads the implicit .goalyrc from the workspace dir', async () => {
    const dir = '/proj';
    const files = { [path.join(dir, IMPLICIT_CONFIG_FILENAME)]: '{ "harness": "fake" }' };
    const loaded = await loadConfig(dir, undefined, fakeReader(files));
    expect(loaded.sources).toEqual([IMPLICIT_CONFIG_FILENAME]);
    expect(loaded.overlay).toEqual({ harness: 'fake' });
  });

  it('names the implicit file ".goalyrc"', () => {
    expect(IMPLICIT_CONFIG_FILENAME).toBe('.goalyrc');
  });

  it('reads an explicit --config file (and records it as a source)', async () => {
    const files = { '/etc/goaly/ci.json': '{ "harness": "codex", "autonomous": true }' };
    const loaded = await loadConfig('/proj', '/etc/goaly/ci.json', fakeReader(files));
    expect(loaded.sources).toEqual(['/etc/goaly/ci.json']);
    expect(loaded.overlay).toEqual({ harness: 'codex', autonomous: true });
  });

  it('layers --config over .goalyrc (explicit wins on conflicts; both are sources)', async () => {
    const dir = '/proj';
    const files = {
      [path.join(dir, IMPLICIT_CONFIG_FILENAME)]: '{ "harness": "fake", "max-iterations": 1 }',
      '/cfg.json': '{ "harness": "codex" }',
    };
    const loaded = await loadConfig(dir, '/cfg.json', fakeReader(files));
    expect(loaded.sources).toEqual([IMPLICIT_CONFIG_FILENAME, '/cfg.json']);
    // .goalyrc supplies max-iterations; --config overrides harness.
    expect(loaded.overlay).toEqual({ harness: 'codex', 'max-iterations': '1' });
  });

  it('fails closed when an explicit --config path does not exist', async () => {
    await expect(loadConfig('/proj', '/missing.json', fakeReader({}))).rejects.toThrow(UsageError);
  });

  describe('home-level ~/.goalyrc layer', () => {
    const home = '/home/u';
    const homeRc = path.join(home, IMPLICIT_CONFIG_FILENAME);

    it('loads the home ~/.goalyrc and labels its source', async () => {
      const files = { [homeRc]: '{ "autonomous": true, "harness": "fake" }' };
      const loaded = await loadConfig('/proj', undefined, fakeReader(files), home);
      expect(loaded.sources).toEqual([HOME_CONFIG_LABEL]);
      expect(loaded.overlay).toEqual({ autonomous: true, harness: 'fake' });
    });

    it('lets the workspace .goalyrc override the home one (home-first sources)', async () => {
      const files = {
        [homeRc]: '{ "harness": "fake", "max-iterations": 2 }',
        [path.join('/proj', IMPLICIT_CONFIG_FILENAME)]: '{ "harness": "codex" }',
      };
      const loaded = await loadConfig('/proj', undefined, fakeReader(files), home);
      expect(loaded.sources).toEqual([HOME_CONFIG_LABEL, IMPLICIT_CONFIG_FILENAME]);
      expect(loaded.overlay).toEqual({ harness: 'codex', 'max-iterations': '2' });
    });

    it('lets --config override both implicit files', async () => {
      const files = {
        [homeRc]: '{ "harness": "fake", "max-iterations": 2 }',
        [path.join('/proj', IMPLICIT_CONFIG_FILENAME)]: '{ "harness": "droid" }',
        '/cfg.json': '{ "harness": "codex" }',
      };
      const loaded = await loadConfig('/proj', '/cfg.json', fakeReader(files), home);
      expect(loaded.sources).toEqual([HOME_CONFIG_LABEL, IMPLICIT_CONFIG_FILENAME, '/cfg.json']);
      expect(loaded.overlay).toEqual({ harness: 'codex', 'max-iterations': '2' });
    });

    it('reads the file once when the cwd IS the home dir (no double-apply)', async () => {
      const files = { [homeRc]: '{ "harness": "fake" }' };
      // dir === home: the home and workspace paths resolve to the same file.
      const loaded = await loadConfig(home, undefined, fakeReader(files), home);
      expect(loaded.sources).toEqual([IMPLICIT_CONFIG_FILENAME]);
      expect(loaded.overlay).toEqual({ harness: 'fake' });
    });
  });

  it('turns invalid JSON into a UsageError', async () => {
    const files = { [path.join('/d', IMPLICIT_CONFIG_FILENAME)]: '{ not json' };
    await expect(loadConfig('/d', undefined, fakeReader(files))).rejects.toThrow(UsageError);
  });

  it('reads a real .goalyrc and ignores a missing one (default reader, end-to-end)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goaly-cfg-'));
    try {
      // Nothing there yet → empty.
      expect(await loadConfig(dir, undefined)).toEqual({ overlay: {}, sources: [] });
      await writeFile(
        path.join(dir, IMPLICIT_CONFIG_FILENAME),
        JSON.stringify({ harness: 'fake', autonomous: true }),
        'utf8',
      );
      const loaded = await loadConfig(dir, undefined);
      expect(loaded.sources).toEqual([IMPLICIT_CONFIG_FILENAME]);
      expect(loaded.overlay).toEqual({ harness: 'fake', autonomous: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('default reader returns undefined for a missing file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goaly-cfg-'));
    try {
      expect(await defaultConfigFileReader(path.join(dir, 'nope.json'))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
