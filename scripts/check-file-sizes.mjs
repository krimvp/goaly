#!/usr/bin/env node
/**
 * Repo-health gate (improvement plan 3.1): no production TypeScript file may exceed the repo's
 * 800-line convention (AGENTS.md → "Small files"). Test files are exempt — a thorough test suite
 * is allowed to be long.
 *
 * Files that already exceeded the limit when this gate landed are grandfathered with a RATCHET:
 * each may not grow beyond its pinned size, and once a refactor brings it under the limit its
 * entry must be deleted (the script fails if an entry is stale, so the list can only shrink).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 800;

/** file → pinned max lines (its size when the gate landed). Shrink-only; never add entries. */
const GRANDFATHERED = new Map([
  ['src/driver/driver.ts', 1152],
  ['src/cli/compose.ts', 1009],
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const failures = [];
for (const file of walk('src')) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
  // Count newline characters (matches `wc -l`), not split() segments — no trailing-newline off-by-one.
  const lines = (readFileSync(file, 'utf8').match(/\n/g) ?? []).length;
  const pinned = GRANDFATHERED.get(file);
  if (pinned !== undefined) {
    if (lines > pinned) {
      failures.push(
        `${file}: ${lines} lines — grandfathered at ${pinned}, and it GREW. Split it (target <= ${LIMIT}).`,
      );
    } else if (lines <= LIMIT) {
      failures.push(
        `${file}: ${lines} lines — now under the ${LIMIT}-line limit. Remove its stale grandfather entry from scripts/check-file-sizes.mjs.`,
      );
    }
    continue;
  }
  if (lines > LIMIT) {
    failures.push(`${file}: ${lines} lines — exceeds the ${LIMIT}-line limit (AGENTS.md). Split it.`);
  }
}

for (const [file] of GRANDFATHERED) {
  try {
    statSync(file);
  } catch {
    failures.push(`${file}: grandfathered but no longer exists — remove its entry from scripts/check-file-sizes.mjs.`);
  }
}

if (failures.length > 0) {
  console.error('file-size gate failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`file-size gate ok (limit ${LIMIT} lines, ${GRANDFATHERED.size} grandfathered)`);
