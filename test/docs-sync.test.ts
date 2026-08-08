/**
 * Docs-sync coverage, as a test (AGENTS.md → "Keep the docs in sync" is a definition-of-done gate).
 *
 * `npm run check:docs` already pins every USAGE flag and config key to `docs/reference.md`. This
 * pins the three things that rot the same way but have no flag to key off:
 *
 *  1. every TYPED terminal reason the CLI can print (`STUCK_*` / `CONTRACT_*`) is documented in the
 *     reference — a new detector cannot ship with an undocumented abort;
 *  2. every README link into the reference resolves to a real heading — the feature table is one
 *     row per feature "linking into the reference", so a renamed heading must not silently 404;
 *  3. the landing page names the terminal outcomes a user is most likely to hit and search for.
 *
 * Documentation-only assertions: nothing here constrains runtime behavior.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const reference = read('docs/reference.md');
const readme = read('README.md');
const landing = read('docs/index.html') + read('docs/assets/app.js');

/** Typed reason tags emitted by the stuck detectors and echoed by the CLI's next-step hints. */
function reasonTags(source: string): string[] {
  const matches = [...source.matchAll(/\b(?:STUCK|CONTRACT)_[A-Z][A-Z_]*\b/g)].map((m) => m[0]);
  // `*_MARKER` is the exported CONSTANT holding a tag, not a tag itself.
  return [...new Set(matches.filter((t) => !t.endsWith('_MARKER')))].sort();
}

/** GitHub's heading → anchor slug (lowercase, punctuation dropped, spaces → dashes). */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 \-_]/g, '')
    .trim()
    .replace(/ /g, '-');
}

describe('docs stay in sync with the code', () => {
  it('documents every typed terminal reason in the reference', () => {
    const tags = reasonTags(read('src/orchestrator/stuck.ts') + read('src/cli/run-cmd.ts'));
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((tag) => !reference.includes(tag))).toEqual([]);
  });

  it('keeps the newest terminal outcomes on the landing page', () => {
    for (const tag of ['CONTRACT_DEFECTIVE', 'STUCK_TIMEOUT_NO_DIFF']) {
      expect(landing).toContain(tag);
    }
  });

  it('resolves every README link into the reference', () => {
    const headings = new Set(
      [...reference.matchAll(/^#{1,6} +(.+)$/gm)].map((m) => slug(m[1] as string)),
    );
    const linked = [...readme.matchAll(/docs\/reference\.md#([a-z0-9\-_]+)/g)].map(
      (m) => m[1] as string,
    );
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter((anchor) => !headings.has(anchor))).toEqual([]);
  });

  it('resolves every in-page link inside the reference', () => {
    const headings = new Set(
      [...reference.matchAll(/^#{1,6} +(.+)$/gm)].map((m) => slug(m[1] as string)),
    );
    const linked = [...reference.matchAll(/\]\(#([a-z0-9\-_]+)\)/g)].map((m) => m[1] as string);
    expect(linked.filter((anchor) => !headings.has(anchor))).toEqual([]);
  });

  it('lists every top-level reference section in its own table of contents', () => {
    const contents = reference.slice(
      reference.indexOf('## Contents'),
      reference.indexOf('## CLI cookbook'),
    );
    const sections = [...reference.matchAll(/^## +(.+)$/gm)]
      .map((m) => slug(m[1] as string))
      .filter((s) => s !== 'contents');
    expect(sections.filter((s) => !contents.includes(`(#${s})`))).toEqual([]);
  });
});
