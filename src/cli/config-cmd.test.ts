import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runConfig } from './config-cmd';

/**
 * `goaly config validate` — the verdict must come from the SAME parser every run uses, so a file
 * this command blesses can never be rejected by a run (and vice versa).
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goaly-config-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Capture = { out: string; err: string };

async function validate(content: string | undefined, name = '.goalyrc'): Promise<Capture & { code: number }> {
  const file = path.join(dir, name);
  if (content !== undefined) await writeFile(file, content, 'utf8');
  const capture: Capture = { out: '', err: '' };
  const code = await runConfig(
    { kind: 'validate', path: file },
    dir,
    (s) => (capture.out += s),
    (s) => (capture.err += s),
  );
  return { ...capture, code };
}

async function listPresets(content: string | undefined, names = false): Promise<Capture & { code: number }> {
  if (content !== undefined) await writeFile(path.join(dir, '.goalyrc'), content, 'utf8');
  const capture: Capture = { out: '', err: '' };
  const code = await runConfig(
    { kind: 'presets', names },
    dir,
    (s) => (capture.out += s),
    (s) => (capture.err += s),
  );
  return { ...capture, code };
}

describe('goaly config validate', () => {
  it('accepts a valid config and lists the settings it carries', async () => {
    const res = await validate('{ "harness": "codex", "max-iterations": 5 }');
    expect(res.code).toBe(0);
    expect(res.out).toContain('valid (2 settings: max-iterations, harness)');
  });

  it('rejects an unknown key with the run path error message (exit 1)', async () => {
    const res = await validate('{ "no-such-flag": true }');
    expect(res.code).toBe(1);
    expect(res.err).toContain("'no-such-flag'");
    expect(res.err).toContain('is invalid');
  });

  it('rejects invalid JSON with the parse error (exit 1)', async () => {
    const res = await validate('{ harness: codex }');
    expect(res.code).toBe(1);
    expect(res.err).toContain('not valid JSON');
  });

  it('a missing file is a usage error (exit 2), not a validation verdict', async () => {
    const res = await validate(undefined);
    expect(res.code).toBe(2);
    expect(res.err).toContain('cannot read');
  });

  it('accepts the array wire form for approver-models', async () => {
    const res = await validate('{ "approver-models": ["a", "b"] }');
    expect(res.code).toBe(0);
    expect(res.out).toContain('approver-models');
  });

  it('reports presets alongside the settings', async () => {
    const res = await validate(
      '{ "harness": "codex", "presets": { "quick": { "mode": "review" }, "ship": { "autonomous": true } } }',
    );
    expect(res.code).toBe(0);
    expect(res.out).toContain('2 presets: quick, ship');
  });

  it('rejects an unknown key inside a preset body, naming the path (exit 1)', async () => {
    const res = await validate('{ "presets": { "quick": { "no-such-flag": true } } }');
    expect(res.code).toBe(1);
    expect(res.err).toContain('presets.quick');
  });

  it("rejects the reserved preset name 'none' (exit 1)", async () => {
    const res = await validate('{ "presets": { "none": { "autonomous": true } } }');
    expect(res.code).toBe(1);
    expect(res.err).toContain("'none' is reserved");
  });
});

describe('goaly config presets', () => {
  it('lists the built-in and each configured preset with its defining source and keys', async () => {
    const res = await listPresets(
      '{ "presets": { "ship": { "mode": "hands-off", "budget-tokens": 500000 }, "quick": { "mode": "review" } } }',
    );
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/default\s+\(built-in\)\s+mode/);
    expect(res.out).toMatch(/quick\s+\(\.goalyrc\)\s+mode/);
    expect(res.out).toMatch(/ship\s+\(\.goalyrc\)\s+mode, budget-tokens/);
  });

  it('--names prints bare names only (the completion wire format), built-in included', async () => {
    const res = await listPresets(
      '{ "presets": { "ship": { "mode": "hands-off" }, "quick": { "mode": "review" } } }',
      true,
    );
    expect(res.code).toBe(0);
    expect(res.out).toBe('default\nquick\nship\n');
  });

  it('with no config file the built-in is still listed, plus the how-to-define hint', async () => {
    const res = await listPresets('{ "harness": "codex" }');
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/default\s+\(built-in\)\s+mode/);
    expect(res.out).toContain('define your own under "presets"');
  });

  it("a config redefinition of 'default' shadows the built-in in the listing", async () => {
    const res = await listPresets('{ "presets": { "default": { "mode": "review" } } }');
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/default\s+\(\.goalyrc\)\s+mode/);
    expect(res.out).not.toContain('(built-in)');
  });

  it('an invalid config file fails the listing loudly (exit 1)', async () => {
    const res = await listPresets('{ "bogus": true }');
    expect(res.code).toBe(1);
    expect(res.err).toContain("'bogus'");
  });
});
