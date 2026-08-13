/**
 * Release-gate coverage. Two releases (v0.2.5, v0.2.6) were tagged and then failed to publish
 * because the CHANGELOG.md check lived only in the publish workflow — i.e. AFTER the immutable tag
 * existed. These pin the fix: the same check is reachable as a script, `make release` runs it
 * before `gh release create`, and `stamp` produces exactly what the check demands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/changelog.mjs', import.meta.url));
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const SAMPLE = `# Changelog

## [Unreleased]

### Fixed
- A thing that was broken.

## [0.2.4] - 2026-08-07

### Added
- An older thing.
`;

/** Run the script; returns its exit code plus the merged output. */
function run(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: e.stdout + e.stderr };
  }
}

describe('the CHANGELOG release gate', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goaly-changelog-'));
    file = join(dir, 'CHANGELOG.md');
    writeFileSync(file, SAMPLE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fails the check for a version with no entry, and passes for one that has it', () => {
    const missing = run(['check', '0.2.6', file]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('make changelog VERSION=0.2.6');

    expect(run(['check', '0.2.4', file]).code).toBe(0);
  });

  it('stamps the [Unreleased] notes under the version, and the check then passes', () => {
    expect(run(['stamp', '0.2.6', file]).code).toBe(0);

    const stamped = readFileSync(file, 'utf8');
    expect(stamped).toMatch(/## \[Unreleased\]\n\n## \[0\.2\.6\] - \d{4}-\d{2}-\d{2}\n\n### Fixed/);
    expect(stamped).toContain('- A thing that was broken.');
    expect(stamped).toContain('## [0.2.4] - 2026-08-07');
    expect(run(['check', '0.2.6', file]).code).toBe(0);
  });

  it('refuses to stamp an empty [Unreleased], a duplicate version, or a non-version', () => {
    writeFileSync(file, '# Changelog\n\n## [Unreleased]\n\n## [0.2.4] - 2026-08-07\n');
    expect(run(['stamp', '0.2.6', file]).out).toContain('nothing to release');

    writeFileSync(file, SAMPLE);
    expect(run(['stamp', '0.2.4', file]).out).toContain("already has a '## [0.2.4]' entry");
    expect(run(['stamp', 'v0.2.6', file]).out).toContain('no leading "v"');
  });

  it('checks the changelog BEFORE the release tag is created', () => {
    const recipe = read('Makefile').slice(read('Makefile').indexOf('\nrelease:'));
    const check = recipe.indexOf('scripts/changelog.mjs check');
    const tag = recipe.indexOf('gh release create');
    expect(check).toBeGreaterThan(-1);
    expect(tag).toBeGreaterThan(check);
  });

  it('keeps the publish workflow on the same check', () => {
    expect(read('.github/workflows/publish.yml')).toContain('node scripts/changelog.mjs check');
  });
});
