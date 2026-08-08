import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runConfig } from './config-cmd';
import { parseArgs, UsageError } from './args';
import { composeDeps } from './compose';
import { FileDefectCorpus, appendAdjudicatedDefect } from '../defects/corpus';
import { asRunId } from '../domain/ids';
import { FakeLlm } from '../llm/provider';
import { InMemoryLogFs, makeConfig, makeFakeContract } from '../testing/fakes';

/**
 * Issue #122 — the operator surface: `goaly config defects list|clear`, the `--no-defect-corpus`
 * escape, and the `--defect-corpus <path>` override.
 */

let dir: string;
let corpusPath: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'goaly-defects-cmd-'));
  corpusPath = path.join(dir, 'defects.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(): Promise<void> {
  const contract = makeFakeContract({
    rungs: [{ kind: 'deterministic', command: 'npx --no-install vitest run verify/db.test.ts' }],
    generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
  });
  await appendAdjudicatedDefect(
    new FileDefectCorpus(corpusPath),
    {
      defective: true,
      pattern: 'asserts a spy call count after the spy was restored',
      assertionShape: 'call-count assertion after restoreAllMocks()',
    },
    { contract, runId: 'run-old', now: Date.UTC(2026, 0, 2) },
  );
}

async function run(action: 'list' | 'clear'): Promise<{ out: string; code: number }> {
  let out = '';
  const code = await runConfig(
    { kind: 'defects', action, path: corpusPath },
    dir,
    (s) => (out += s),
    () => {},
  );
  return { out, code };
}

describe('goaly config defects', () => {
  it('list prints every recorded pattern with its context and provenance', async () => {
    await seed();
    const { out, code } = await run('list');
    expect(code).toBe(0);
    expect(out).toContain('1 recorded defect');
    expect(out).toContain('asserts a spy call count after the spy was restored');
    expect(out).toContain('typescript/vitest');
    expect(out).toContain('call-count assertion after restoreAllMocks()');
    expect(out).toContain('run-old');
    // The list names the only writer, so the operator knows what can (and cannot) add to it.
    expect(out).toContain('only an adjudicated CONTRACT_DEFECTIVE verdict can add to this');
  });

  it('list on a missing corpus says so and exits 0 (fail-open, never an error)', async () => {
    const { out, code } = await run('list');
    expect(code).toBe(0);
    expect(out).toContain('no recorded defects');
  });

  it('clear resets the corpus', async () => {
    await seed();
    expect(new FileDefectCorpus(corpusPath).read()).toHaveLength(1);
    const { out, code } = await run('clear');
    expect(code).toBe(0);
    expect(out).toContain('cleared the defect corpus');
    expect(new FileDefectCorpus(corpusPath).read()).toEqual([]);
  });
});

describe('the --defect-corpus flags', () => {
  const base = ['run', '--goal', 'g', '--verify-cmd', 'true'];

  it('defaults to ON with the default path', async () => {
    expect((await parseArgs(base)).defects).toEqual({ enabled: true });
  });

  it('--no-defect-corpus turns the whole channel off', async () => {
    expect((await parseArgs([...base, '--no-defect-corpus'])).defects).toEqual({ enabled: false });
  });

  it('--defect-corpus <path> overrides the file', async () => {
    const parsed = await parseArgs([...base, '--defect-corpus', '/tmp/d.jsonl']);
    expect(parsed.defects).toEqual({ enabled: true, path: '/tmp/d.jsonl' });
  });

  it('fails closed on the contradictory pair', async () => {
    await expect(
      parseArgs([...base, '--defect-corpus', '/tmp/d.jsonl', '--no-defect-corpus']),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it('is settable from a config file (it is persistent wiring, not per-invocation)', async () => {
    await writeFile(
      path.join(dir, '.goalyrc'),
      JSON.stringify({ 'defect-corpus': path.join(dir, 'team.jsonl') }),
      'utf8',
    );
    const parsed = await parseArgs([...base, '--workspace', dir]);
    expect(parsed.defects).toEqual({ enabled: true, path: path.join(dir, 'team.jsonl') });
  });

  it('config defects rejects an unknown action', async () => {
    await expect(parseArgs(['config', 'defects', 'wipe'])).rejects.toBeInstanceOf(UsageError);
  });

  it('config defects list parses with the corpus override', async () => {
    const parsed = await parseArgs(['config', 'defects', 'list', '--defect-corpus', '/tmp/d.jsonl']);
    expect(parsed.configCmd).toEqual({ kind: 'defects', action: 'list', path: '/tmp/d.jsonl' });
  });
});

describe('composeDeps wiring (issue #122)', () => {
  const opts = (over: Record<string, unknown> = {}) => ({
    harness: 'fake' as const,
    workspaceRoot: dir,
    runId: asRunId('run-1'),
    llm: new FakeLlm(['{}']),
    noLogConsole: true,
    logFs: new InMemoryLogFs(),
    ...over,
  });

  it('hands the Driver a corpus writer by default, and NONE under --no-defect-corpus', () => {
    const on = composeDeps(makeConfig(), opts({ defects: { enabled: true, path: corpusPath } }));
    expect(on.defectCorpus?.path).toBe(corpusPath);

    const off = composeDeps(makeConfig(), opts({ defects: { enabled: false } }));
    expect(off.defectCorpus).toBeUndefined();
  });
});
