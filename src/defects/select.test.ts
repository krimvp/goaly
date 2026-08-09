import { appendFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  DEFECT_RECORD_VERSION,
  FileDefectCorpus,
  type AdjudicatedDefect,
  type DefectRecord,
} from './corpus';
import { contractDefectContext, workspaceDefectContext } from './context';
import { DEFAULT_DEFECT_HINT_CAP, formatDefectSection, selectDefectHints } from './select';
import {
  DEFECT_TRUST_FENCED_ONLY,
  DEFECT_TRUST_SANDBOXED,
  resolveDefectCorpus,
} from './wiring';
import { makeFakeContract, recordingLogger } from '../testing/fakes';

/** Issue #122 — relevance filtering, the bound on prompt size, and the compose-time resolution. */

let n = 0;
function rec(over: Partial<DefectRecord> = {}): DefectRecord {
  n += 1;
  return {
    v: DEFECT_RECORD_VERSION,
    n: randomBytes(16).toString('hex'),
    ts: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(),
    pattern: `pattern ${n}`,
    language: 'typescript',
    runner: 'vitest',
    contractHash: 'c'.repeat(64),
    runId: `run-${n}`,
    ...over,
  } as DefectRecord;
}

const jsCtx = { languages: ['javascript', 'typescript'] as const, runners: ['vitest'] as const };

describe('contractDefectContext — derived from the FROZEN contract only', () => {
  it.each([
    ['pytest -q tests/', ['python', 'pytest'], ['python'], 'verify/test_db.py'],
    ['go test ./...', ['go', 'go-test'], ['go'], 'verify/db_test.go'],
    ['cargo test --all', ['rust', 'cargo-test'], ['cargo'], 'verify/db.rs'],
    ['npx --no-install jest', ['javascript', 'jest'], ['node'], 'verify/db.test.js'],
  ])('%s ⇒ %s', (command, expected, tools, file) => {
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command }],
      requiredTools: tools,
      generatedFiles: [{ path: file, sha256: 'a'.repeat(64) }],
    });
    expect(contractDefectContext(contract)).toEqual({
      language: expected[0],
      runner: expected[1],
    });
  });

  it('an unrecognizable bar is "unknown", never a guess dressed as a fact', () => {
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: './check.sh' }] });
    expect(contractDefectContext(contract)).toEqual({ language: 'unknown', runner: 'unknown' });
  });
});

describe('workspaceDefectContext — fail-soft probes of the tree', () => {
  it('detects the ecosystems present, and nothing for an empty tree', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'goaly-defect-ws-'));
    expect(workspaceDefectContext(dir)).toEqual({ languages: [], runners: [] });

    writeFileSync(path.join(dir, 'package.json'), '{"devDependencies":{"vitest":"^3"}}');
    writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    const ctx = workspaceDefectContext(dir);
    expect(ctx.languages).toEqual(['javascript', 'typescript']);
    expect(ctx.runners).toEqual(['vitest']);
  });

  it('an unparseable manifest contributes nothing rather than throwing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'goaly-defect-ws-'));
    mkdirSync(path.join(dir, 'package.json')); // a DIRECTORY where a manifest should be
    expect(() => workspaceDefectContext(dir)).not.toThrow();
  });
});

describe('selectDefectHints — relevant, deduped, and BOUNDED', () => {
  it('drops records from another ecosystem, keeps ecosystem-agnostic ones', () => {
    const hints = selectDefectHints(
      [
        rec({ pattern: 'js one' }),
        rec({ pattern: 'py one', language: 'python', runner: 'pytest' }),
        rec({ pattern: 'agnostic', language: 'unknown', runner: 'unknown' }),
      ],
      jsCtx,
    );
    expect(hints.map((h) => h.text)).toEqual(['js one', 'agnostic']);
  });

  it('caps the section regardless of corpus size, and never exceeds the cap', () => {
    const many = Array.from({ length: 5000 }, () => rec());
    expect(selectDefectHints(many, jsCtx)).toHaveLength(DEFAULT_DEFECT_HINT_CAP);
    expect(selectDefectHints(many, jsCtx, 2)).toHaveLength(2);
    expect(selectDefectHints(many, jsCtx, 0)).toEqual([]);
    const section = formatDefectSection(selectDefectHints(many, jsCtx));
    expect(section.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(
      DEFAULT_DEFECT_HINT_CAP,
    );
    expect(section.length).toBeLessThan(4000);
  });

  it('collapses duplicates and ranks by runner match, then frequency, then recency', () => {
    const hints = selectDefectHints(
      [
        rec({ pattern: 'rare but exact', runner: 'vitest' }),
        rec({ pattern: 'common elsewhere', runner: 'jest' }),
        rec({ pattern: 'common elsewhere', runner: 'jest' }),
        rec({ pattern: 'common elsewhere', runner: 'jest' }),
      ],
      jsCtx,
    );
    expect(hints[0]).toEqual({ text: 'rare but exact', occurrences: 1 });
    expect(hints[1]).toEqual({ text: 'common elsewhere', occurrences: 3 });
  });

  it('keeps a sibling-language record (a vitest false-red is fatal in JS and TS alike)', () => {
    const hints = selectDefectHints([rec({ language: 'typescript' })], {
      languages: ['javascript'],
      runners: ['vitest'],
    });
    expect(hints).toHaveLength(1);
  });

  it('an empty workspace context filters nothing (no basis to exclude)', () => {
    const hints = selectDefectHints([rec({ language: 'python', runner: 'pytest' })], {
      languages: [],
      runners: [],
    });
    expect(hints).toHaveLength(1);
  });

  it('renders the assertion shape alongside the pattern', () => {
    const hints = selectDefectHints([rec({ pattern: 'p', assertionShape: 's' })], jsCtx);
    expect(hints[0]?.text).toBe('p (offending assertion shape: s)');
  });
});

describe('formatDefectSection — impossibility, never "make it easier"', () => {
  it('is empty when there is nothing to say (the prompt stays byte-identical)', () => {
    expect(formatDefectSection([])).toBe('');
  });

  it('frames the list as unsatisfiability and explicitly forbids weakening the bar', () => {
    // A fixed nonce so the (random) fence markers cannot collide with the digit assertion below.
    const section = formatDefectSection([{ text: 'p', occurrences: 3 }], { nonce: 'nonce' });
    expect(section).toMatch(/DO NOT AUTHOR THESE/);
    expect(section).toMatch(/impossible to satisfy/);
    expect(section).toMatch(/never a reason to make the bar easier/);
    expect(section).toMatch(/just as strict, but satisfiable/);
    // The frequency count is ranking input only — it must not become "this was hard" in the prompt.
    expect(section).not.toContain('3');
  });

  it('fences the hint lines as UNTRUSTED data (they are model-authored text)', () => {
    const section = formatDefectSection([{ text: 'p', occurrences: 1 }], { nonce: 'abc' });
    expect(section).toContain('<<UNTRUSTED DEFECT PATTERNS abc>>');
    expect(section).toContain('<</UNTRUSTED DEFECT PATTERNS abc>>');
    // goaly's own framing stays OUTSIDE the fence; only the model text is inside it.
    expect(section.indexOf('DO NOT AUTHOR THESE')).toBeLessThan(section.indexOf('<<UNTRUSTED'));
  });
});

describe('resolveDefectCorpus — the compose-time resolution', () => {
  function workspace(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'goaly-defect-res-'));
    writeFileSync(path.join(dir, 'package.json'), '{"devDependencies":{"vitest":"^3"}}');
    return dir;
  }

  it('reads, filters, injects, and LOGS which patterns shaped the bar', async () => {
    const dir = workspace();
    const corpusPath = path.join(dir, 'defects.jsonl');
    // Seeded through the corpus itself: a corpus line only counts when it carries the HMAC of the
    // local key, so a hand-written JSONL line would (correctly) be dropped — see corpus-integrity.
    const seed = new FileDefectCorpus(corpusPath);
    await seed.append(rec({ pattern: 'no post-restore call counts' }) as AdjudicatedDefect);
    await seed.append(
      rec({ pattern: 'python only', language: 'python', runner: 'pytest' }) as AdjudicatedDefect,
    );
    appendFileSync(corpusPath, 'garbage\n', 'utf8');
    const { logger, records } = recordingLogger();
    const resolved = resolveDefectCorpus({ enabled: true, path: corpusPath }, dir, logger);

    expect(resolved.corpus?.path).toBe(corpusPath);
    expect(resolved.section).toContain('no post-restore call counts');
    expect(resolved.section).not.toContain('python only');
    const log = records.find((r) => r.msg.includes('injecting known false-red patterns'));
    expect(log?.fields['patterns']).toEqual(['no post-restore call counts']);
  });

  /**
   * Cluster B' — the injection log must say what the signature is worth ON THIS RUN, because the
   * answer differs by sandbox policy: with `--sandbox none` the agent shares goaly's uid and can
   * read the signing key, so the hints are contained by the untrusted fence and NOT by the HMAC.
   * Stating that in the diagnostics is the honest alternative to implying a guarantee we don't have.
   */
  it.each([
    ['no sandbox: the hints are fenced, not vouched for', false, DEFECT_TRUST_FENCED_ONLY],
    ['an active sandbox masks $HOME/.goaly from the agent', true, DEFECT_TRUST_SANDBOXED],
  ])('LOGS how much the provenance is worth — %s', async (_label, sandboxed, expected) => {
    const dir = workspace();
    const corpusPath = path.join(dir, 'defects.jsonl');
    const seed = new FileDefectCorpus(corpusPath);
    await seed.append(rec({ pattern: 'no post-restore call counts' }) as AdjudicatedDefect);
    const { logger, records } = recordingLogger();
    resolveDefectCorpus(
      { enabled: true, path: corpusPath },
      dir,
      logger,
      DEFAULT_DEFECT_HINT_CAP,
      sandboxed,
    );
    const log = records.find((r) => r.msg.includes('injecting known false-red patterns'));
    expect(log?.fields['trust']).toBe(expected);
  });

  it('the un-sandboxed trust line does not claim the signature stops the agent', () => {
    expect(DEFECT_TRUST_FENCED_ONLY).toContain('same uid');
    expect(DEFECT_TRUST_FENCED_ONLY).toContain('untrusted fence');
    expect(DEFECT_TRUST_SANDBOXED).toContain('$HOME/.goaly');
  });

  it('--no-defect-corpus: no corpus (nothing can be written) and no section', () => {
    const dir = workspace();
    const { logger } = recordingLogger();
    const resolved = resolveDefectCorpus({ enabled: false }, dir, logger);
    expect(resolved.corpus).toBeUndefined();
    expect(resolved.section).toBe('');
  });

  it('FAIL-OPEN: a missing corpus resolves to no section and still hands back a writer', () => {
    const dir = workspace();
    const { logger, records } = recordingLogger();
    const resolved = resolveDefectCorpus(
      { enabled: true, path: path.join(dir, 'nope.jsonl') },
      dir,
      logger,
    );
    expect(resolved.section).toBe('');
    expect(resolved.corpus).toBeDefined();
    expect(records.some((r) => r.msg.includes('injecting'))).toBe(false);
  });
});
