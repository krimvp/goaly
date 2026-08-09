import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  MAX_RECORDS_PER_RUN,
  FileDefectCorpus,
  appendAdjudicatedDefect,
  fromAdjudication,
} from './corpus';
import { DEFAULT_DEFECT_HINT_CAP, selectDefectHints } from './select';
import { makeFakeContract } from '../testing/fakes';

/**
 * Cluster B' — REPLAY, and the key's own fail-open edges.
 *
 * The HMAC proves a line was minted by an adjudication of ours. It does NOT prove the line is
 * there once: an append-only adversary who cannot forge a byte can still COPY a genuine line, and
 * before this file every copy counted as another occurrence. `occurrences` is the second sort key
 * in {@link selectDefectHints} and the section is capped at five, so forty copies of one line
 * pinned that pattern to the top and pushed every other hint out of the prompt — a key-free
 * manipulation of which hints reach the author.
 *
 * The fix is identity, not secrecy: every record carries a per-record nonce INSIDE the signed
 * payload, so a copy is recognizable as the same record rather than a second one, and `read()`
 * de-duplicates (by nonce, and by `(contractHash, runId, pattern, assertionShape)`) and caps what
 * any single `(contractHash, runId)` may contribute.
 */

const contract = makeFakeContract({
  rungs: [{ kind: 'deterministic', command: 'npx --no-install vitest run verify/db.test.ts' }],
  generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
});
const jsCtx = { languages: ['typescript'] as const, runners: ['vitest'] as const };

function provenanceFor(runId: string, dayOfMonth: number) {
  return { contract, runId, now: Date.UTC(2026, 0, dayOfMonth, 3, 4, 5) };
}

const provenance = provenanceFor('run-1', 2);

function tempCorpus(): FileDefectCorpus {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'goaly-defect-replay-'));
  return new FileDefectCorpus(path.join(dir, 'nested', 'defects.jsonl'));
}

/** Append `copies` byte-identical duplicates of the corpus's last line — the whole attack. */
function replayLastLine(corpus: FileDefectCorpus, copies: number): void {
  const lines = readFileSync(corpus.path, 'utf8').trim().split('\n');
  const last = lines[lines.length - 1];
  expect(last).toBeDefined();
  appendFileSync(corpus.path, `${last}\n`.repeat(copies), 'utf8');
}

describe('a genuine signed line cannot be REPLAYED into influence', () => {
  it('forty byte-identical copies of one genuine line still read as ONE record (the PoC)', async () => {
    const corpus = tempCorpus();
    await appendAdjudicatedDefect(
      corpus,
      { defective: true, pattern: 'asserts a spy call count after the spy was restored' },
      provenance,
    );
    expect(corpus.read()).toHaveLength(1);

    replayLastLine(corpus, 40);
    expect(readFileSync(corpus.path, 'utf8').trim().split('\n')).toHaveLength(41);

    expect(corpus.read()).toHaveLength(1);
    expect(selectDefectHints(corpus.read(), jsCtx)).toEqual([
      { text: 'asserts a spy call count after the spy was restored', occurrences: 1 },
    ]);
  });

  it('a replayed line cannot push the other hints out of the capped section', async () => {
    const patterns = [
      'asserts a spy call count after the spy was restored',
      'asserts on a private field the goal never names',
      'asserts wall-clock ordering between two unsynchronized writers',
      'asserts an exact byte count of generated output',
      'asserts a log line that the goal never specifies',
      'asserts a network call against a host the goal forbids',
    ];

    async function seed(corpus: FileDefectCorpus): Promise<void> {
      for (const [i, pattern] of patterns.entries()) {
        await appendAdjudicatedDefect(corpus, { defective: true, pattern }, provenanceFor(`run-${i}`, i + 1));
      }
    }

    const honest = tempCorpus();
    await seed(honest);
    const expected = selectDefectHints(honest.read(), jsCtx);
    expect(expected).toHaveLength(DEFAULT_DEFECT_HINT_CAP);

    const attacked = tempCorpus();
    await seed(attacked);
    // The adversary replays the OLDEST line — the one the cap would otherwise drop.
    const lines = readFileSync(attacked.path, 'utf8').trim().split('\n');
    const oldest = lines[0];
    expect(oldest).toBeDefined();
    appendFileSync(attacked.path, `${oldest}\n`.repeat(40), 'utf8');

    expect(selectDefectHints(attacked.read(), jsCtx)).toEqual(expected);
    expect(selectDefectHints(attacked.read(), jsCtx).map((h) => h.occurrences)).toEqual(
      Array.from({ length: DEFAULT_DEFECT_HINT_CAP }, () => 1),
    );
  });

  it('caps how many records a single (contractHash, runId) can contribute', async () => {
    const corpus = tempCorpus();
    for (let i = 0; i < MAX_RECORDS_PER_RUN + 4; i += 1) {
      await appendAdjudicatedDefect(
        corpus,
        { defective: true, pattern: `asserts on the state of subsystem number ${i}` },
        provenance, // the SAME run, over and over
      );
    }
    expect(corpus.read()).toHaveLength(MAX_RECORDS_PER_RUN);
  });

  it('collapses the same pattern re-recorded by the same run', async () => {
    const corpus = tempCorpus();
    const verdict = { defective: true, pattern: 'asserts a spy call count after the spy was restored' };
    await appendAdjudicatedDefect(corpus, verdict, provenance);
    await appendAdjudicatedDefect(corpus, verdict, provenance);
    expect(corpus.read()).toHaveLength(1);
  });

  it('keeps genuinely distinct adjudications of the same pattern from DIFFERENT runs', async () => {
    const corpus = tempCorpus();
    const verdict = { defective: true, pattern: 'asserts a spy call count after the spy was restored' };
    await appendAdjudicatedDefect(corpus, verdict, provenanceFor('run-a', 2));
    await appendAdjudicatedDefect(corpus, verdict, provenanceFor('run-b', 3));
    expect(corpus.read()).toHaveLength(2);
    expect(selectDefectHints(corpus.read(), jsCtx)[0]?.occurrences).toBe(2);
  });
});

describe('the nonce is part of the signed payload', () => {
  it('every mint gets a fresh nonce, even for an identical verdict and clock', () => {
    const a = fromAdjudication({ defective: true, pattern: 'p' }, provenance);
    const b = fromAdjudication({ defective: true, pattern: 'p' }, provenance);
    expect(a?.n).toMatch(/^[0-9a-f]{32}$/);
    expect(b?.n).toMatch(/^[0-9a-f]{32}$/);
    expect(a?.n).not.toBe(b?.n);
  });

  it('re-nonced copies do not verify — the nonce cannot be freshened without the key', async () => {
    const corpus = tempCorpus();
    await appendAdjudicatedDefect(corpus, { defective: true, pattern: 'genuine' }, provenance);
    const genuine = readFileSync(corpus.path, 'utf8').trim();
    const original = JSON.parse(genuine) as { n: string };
    // Exactly what an append-only adversary would try to defeat nonce de-duplication.
    appendFileSync(
      corpus.path,
      `${genuine.replace(original.n, 'f'.repeat(32))}\n`,
      'utf8',
    );
    expect(corpus.read()).toHaveLength(1);
  });
});

describe('every key failure yields no records, never a throw and never a blocked run', () => {
  async function seeded(): Promise<FileDefectCorpus> {
    const corpus = tempCorpus();
    await appendAdjudicatedDefect(corpus, { defective: true, pattern: 'genuine' }, provenance);
    expect(corpus.read()).toHaveLength(1);
    return corpus;
  }

  it('key file deleted (ENOENT)', async () => {
    const corpus = await seeded();
    const gone = path.join(path.dirname(corpus.path), 'absent.key');
    const reader = new FileDefectCorpus(corpus.path, gone);
    expect(reader.read()).toEqual([]);
  });

  it('key file empty', async () => {
    const corpus = await seeded();
    writeFileSync(corpus.keyPath, '', 'utf8');
    expect(corpus.read()).toEqual([]);
  });

  it('key path is a DIRECTORY (EISDIR)', async () => {
    const corpus = tempCorpus();
    mkdirSync(path.dirname(corpus.path), { recursive: true });
    mkdirSync(corpus.keyPath, { recursive: true });
    writeFileSync(corpus.path, '{"not":"verifiable"}\n', 'utf8');
    expect(corpus.read()).toEqual([]);
    // …and the write side degrades to "did not learn" rather than throwing.
    await expect(
      appendAdjudicatedDefect(corpus, { defective: true, pattern: 'p' }, provenance),
    ).resolves.toMatchObject({ pattern: 'p' });
    expect(corpus.read()).toEqual([]);
  });

  it('key contents are not hex', async () => {
    const corpus = await seeded();
    writeFileSync(corpus.keyPath, 'not a key at all\n', 'utf8');
    expect(corpus.read()).toEqual([]);
  });

  it('key contents are hex but the wrong length', async () => {
    const corpus = await seeded();
    writeFileSync(corpus.keyPath, 'deadbeef\n', 'utf8');
    expect(corpus.read()).toEqual([]);
  });

  it('key path traverses a non-directory (ENOTDIR)', async () => {
    const corpus = tempCorpus();
    mkdirSync(path.dirname(corpus.path), { recursive: true });
    const blocker = path.join(path.dirname(corpus.path), 'blocker');
    writeFileSync(blocker, 'i am a file', 'utf8');
    const reader = new FileDefectCorpus(corpus.path, path.join(blocker, 'defects.key'));
    expect(reader.read()).toEqual([]);
    await expect(
      appendAdjudicatedDefect(reader, { defective: true, pattern: 'p' }, provenance),
    ).resolves.toMatchObject({ pattern: 'p' });
    expect(reader.read()).toEqual([]);
  });
});
