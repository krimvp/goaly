import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Invariant #1, enforced STRUCTURALLY rather than by discipline: `src/orchestrator/**` — the pure
 * reducer — may not contain an effect. Issue #116 adds a whole new decision path (the contract-fault
 * gate) and a new pure module (`prompts.ts`) to this directory, so the rule is pinned by a source
 * scan: if someone ever `await`s an LLM here to "just check the contract", this fails.
 */

const DIR = join(import.meta.dirname, '.');

/**
 * The reducer's CODE, with comments stripped — these files document their own purity at length
 * ("returns no Promise", "no LLM"), so a naive scan would trip on the very prose that explains the
 * rule. Only executable text is checked.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function productionSources(): { file: string; text: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, text: stripComments(readFileSync(join(DIR, f), 'utf8')) }));
}

/** Each rule is a regex that must NOT appear in any reducer source file. */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['a Promise (the reducer is synchronous)', /\bPromise\s*</],
  ['await', /\bawait\b/],
  ['async', /\basync\b/],
  ['a node builtin import', /from '\s*node:/],
  ['a driver import', /from '\.\.\/driver/],
  ['an LLM import', /from '\.\.\/llm/],
  ['a verify/adapter import', /from '\.\.\/(verify|harness|workspace|runlog|agent-cli)/],
  ['a clock/date read', /\bDate\.now\(|new Date\(/],
  ['a process read', /\bprocess\./],
  ['console output', /\bconsole\./],
];

describe('reducer purity (invariant #1) — a structural source scan', () => {
  it('scans a non-trivial set of files (the guard itself is not vacuous)', () => {
    const files = productionSources().map((s) => s.file);
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files).toContain('step.ts');
    expect(files).toContain('decide.ts');
    expect(files).toContain('stuck.ts');
    expect(files).toContain('prompts.ts');
  });

  it.each(FORBIDDEN)('no reducer source contains %s', (_label, pattern) => {
    const offenders = productionSources()
      .filter((s) => pattern.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
