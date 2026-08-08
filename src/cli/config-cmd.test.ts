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
});
