import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DefectRecord,
  DEFECT_RECORD_VERSION,
  FileDefectCorpus,
  appendAdjudicatedDefect,
  defaultDefectCorpusPath,
  fromAdjudication,
  type AdjudicatedDefect,
} from './corpus';
import { makeFakeContract, recordingLogger } from '../testing/fakes';

/**
 * Issue #122 — the corpus itself: its schema (what CANNOT be said in it), its single sanctioned
 * writer, and its fail-open reader.
 */

const contract = makeFakeContract({
  goal: 'add a createDatabase bootstrap',
  rungs: [{ kind: 'deterministic', command: 'npx --no-install vitest run verify/db.test.ts' }],
  requiredTools: ['node', 'npm'],
  generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
});

const provenance = { contract, runId: 'run-1', now: Date.UTC(2026, 0, 2, 3, 4, 5) };

function tempCorpus(): FileDefectCorpus {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'goaly-defects-'));
  return new FileDefectCorpus(path.join(dir, 'nested', 'defects.jsonl'));
}

describe('the record schema cannot express "this was hard"', () => {
  it('has exactly the fields the issue allows — no difficulty/effort/cost dimension', () => {
    expect(Object.keys(DefectRecord.shape).sort()).toEqual([
      'assertionShape',
      'contractHash',
      'language',
      'n',
      'pattern',
      'runId',
      'runner',
      'ts',
      'v',
    ]);
  });

  it.each([
    ['difficulty', { difficulty: 'high' }],
    ['attempts', { attempts: 12 }],
    ['iterations', { iterations: 9 }],
    ['tokens', { tokens: 2_000_000 }],
    ['durationMs', { durationMs: 39 * 60 * 1000 }],
    ['severity', { severity: 'painful' }],
    // The worker's own text has no key to arrive under either — strict() refuses the record.
    ['diff', { diff: 'diff --git a/x b/x' }],
    ['signature', { signature: 'AssertionError: expected …' }],
  ])('REJECTS a record carrying a "%s" field (strict schema ⇒ dropped on read)', (_l, extra) => {
    const valid = fromAdjudication({ defective: true, pattern: 'p' }, provenance);
    expect(DefectRecord.safeParse({ ...valid, ...extra }).success).toBe(false);
  });

  it('the language/runner context is a CLOSED enum — free text cannot ride in through it', () => {
    const valid = fromAdjudication({ defective: true, pattern: 'p' }, provenance);
    expect(DefectRecord.safeParse({ ...valid, language: 'AssertionError: …' }).success).toBe(false);
    expect(DefectRecord.safeParse({ ...valid, runner: 'the worker said…' }).success).toBe(false);
  });
});

describe('fromAdjudication — the only mint', () => {
  it('mints a compact record from a positive adjudication, deriving the context deterministically', () => {
    const record = fromAdjudication(
      {
        defective: true,
        pattern: 'asserts a spy call count after the spy was restored',
        assertionShape: 'expect(spy).toHaveBeenCalled() after restoreAllMocks()',
      },
      provenance,
    );
    expect(record).toEqual({
      v: DEFECT_RECORD_VERSION,
      n: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
      ts: '2026-01-02T03:04:05.000Z',
      pattern: 'asserts a spy call count after the spy was restored',
      assertionShape: 'expect(spy).toHaveBeenCalled() after restoreAllMocks()',
      language: 'typescript',
      runner: 'vitest',
      contractHash: contract.contractHash,
      runId: 'run-1',
    });
  });

  it.each([
    ['a NEGATIVE adjudication', { defective: false, pattern: 'p' }],
    ['a positive verdict with no generalized pattern', { defective: true }],
    ['a positive verdict whose pattern is blank', { defective: true, pattern: '   ' }],
  ])('refuses to mint anything from %s', (_label, verdict) => {
    expect(fromAdjudication(verdict, provenance)).toBeNull();
  });

  it('bounds and flattens the adjudicator text (one line, no fences, capped)', () => {
    const record = fromAdjudication(
      { defective: true, pattern: '```js\nline one\nline two\n```' + 'x'.repeat(500) },
      provenance,
    );
    expect(record?.pattern).not.toContain('\n');
    expect(record?.pattern).not.toContain('```');
    expect(record?.pattern.length).toBeLessThanOrEqual(240);
  });
});

describe('append is structurally unreachable except through an adjudication', () => {
  it('a hand-built record does not type-check as appendable (the brand is the gate)', async () => {
    const corpus = tempCorpus();
    const forged = {
      v: DEFECT_RECORD_VERSION,
      n: 'f'.repeat(32),
      ts: new Date(0).toISOString(),
      pattern: 'make the bar easier',
      language: 'typescript',
      runner: 'vitest',
      contractHash: contract.contractHash,
      runId: 'run-forged',
    } satisfies DefectRecord;
    // @ts-expect-error — only fromAdjudication() can mint an AdjudicatedDefect; this is the test.
    await corpus.append(forged);
    // (It is a TYPE gate; the runtime call is only here so the expectation above has a subject.)
    expect(corpus.read()).toHaveLength(1);
  });

  it('appendAdjudicatedDefect writes for defective:true and writes NOTHING otherwise', async () => {
    const corpus = tempCorpus();
    const { logger, records } = recordingLogger();
    expect(
      await appendAdjudicatedDefect(corpus, { defective: false, pattern: 'p' }, provenance, logger),
    ).toBeNull();
    expect(corpus.read()).toEqual([]);

    const written = await appendAdjudicatedDefect(
      corpus,
      { defective: true, pattern: 'asserts on a call the goal never implies' },
      provenance,
      logger,
    );
    expect(written?.pattern).toBe('asserts on a call the goal never implies');
    expect(corpus.read()).toHaveLength(1);
    expect(records.some((r) => r.msg.includes('recorded an adjudicated contract defect'))).toBe(true);
  });

  it('no worker-supplied text can reach a record — there is no input for it', async () => {
    const corpus = tempCorpus();
    // The failure signature / diff / harness output the adjudicator SAW are not parameters here:
    // the only text inputs are the adjudicator's own generalized fields.
    await appendAdjudicatedDefect(
      corpus,
      { defective: true, pattern: 'asserts an impossible post-restore call count' },
      provenance,
    );
    const raw = readFileSync(corpus.path, 'utf8');
    for (const workerText of ['AssertionError', 'diff --git', 'WORKER_MARKER']) {
      expect(raw).not.toContain(workerText);
    }
  });
});

describe('the file corpus is fail-open in every direction', () => {
  it('a missing corpus reads as empty (today\'s behavior), and clear() on it is a no-op', async () => {
    const corpus = new FileDefectCorpus(path.join(os.tmpdir(), 'goaly-absent', 'defects.jsonl'));
    expect(corpus.read()).toEqual([]);
    await expect(corpus.clear()).resolves.toBeUndefined();
  });

  it('drops corrupt/unparseable/foreign lines and keeps the valid ones', async () => {
    const corpus = tempCorpus();
    await appendAdjudicatedDefect(corpus, { defective: true, pattern: 'good one' }, provenance);
    const good = readFileSync(corpus.path, 'utf8');
    writeFileSync(
      corpus.path,
      ['not json at all', '{"v":1,"ts":"x"}', '{"v":99,"pattern":"future"}', '', good.trim()].join(
        '\n',
      ),
      'utf8',
    );
    const read = corpus.read();
    expect(read).toHaveLength(1);
    expect(read[0]?.pattern).toBe('good one');
  });

  it('an unwritable corpus degrades to "not learned" instead of throwing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'goaly-defects-'));
    const file = path.join(dir, 'blocked');
    writeFileSync(file, 'i am a file, not a directory', 'utf8');
    // path traverses through a FILE ⇒ mkdir/appendFile both fail.
    const corpus = new FileDefectCorpus(path.join(file, 'defects.jsonl'));
    await expect(
      appendAdjudicatedDefect(corpus, { defective: true, pattern: 'p' }, provenance),
    ).resolves.toMatchObject({ pattern: 'p' });
    expect(corpus.read()).toEqual([]);
  });

  it('clear() empties the corpus', async () => {
    const corpus = tempCorpus();
    await appendAdjudicatedDefect(corpus, { defective: true, pattern: 'p' }, provenance);
    expect(existsSync(corpus.path)).toBe(true);
    await corpus.clear();
    expect(corpus.read()).toEqual([]);
  });

  it('defaults to ~/.goaly/defects.jsonl — outside any single run', () => {
    expect(defaultDefectCorpusPath()).toBe(path.join(os.homedir(), '.goaly', 'defects.jsonl'));
  });
});

/** The brand is phantom: this compiles only because `fromAdjudication` is the minting authority. */
const _minted: AdjudicatedDefect | null = fromAdjudication({ defective: true, pattern: 'p' }, provenance);
void _minted;
