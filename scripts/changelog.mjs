#!/usr/bin/env node
/**
 * Release-notes gate for CHANGELOG.md: a version cannot publish without an entry.
 *
 * The gate used to live only inside `.github/workflows/publish.yml`, which runs *after* the release
 * tag exists — and `v*` tags are immutable, so a missing entry burned the version instead of
 * failing early. `make release` now runs the same `check` BEFORE it creates the tag, and `stamp`
 * performs the [Unreleased] → [X.Y.Z] move that the check asks for.
 *
 *   node scripts/changelog.mjs check <version> [file]
 *   node scripts/changelog.mjs stamp <version> [file]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const UNRELEASED = '## [Unreleased]';
const [command, version, file = 'CHANGELOG.md'] = process.argv.slice(2);

function fail(message) {
  console.error(`changelog: ${message}`);
  process.exit(1);
}

if (command !== 'check' && command !== 'stamp') {
  fail('usage: node scripts/changelog.mjs <check|stamp> <version> [file]');
}
// Same shape the publish workflow accepts from the release tag, minus the leading "v".
if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(version ?? '')) {
  fail(`'${version ?? ''}' is not a version — expected X.Y.Z with no leading "v".`);
}

const text = readFileSync(file, 'utf8');
const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm');

if (command === 'check') {
  if (!heading.test(text)) {
    fail(
      `${file} has no '## [${version}]' entry — a release with no notes is invisible to users.\n` +
        `  Fix it with:  make changelog VERSION=${version}  (moves the [Unreleased] notes under it),\n` +
        '  then commit that to main and release.',
    );
  }
  console.log(`changelog ok: ${file} documents ${version}`);
  process.exit(0);
}

if (heading.test(text)) fail(`${file} already has a '## [${version}]' entry.`);
const start = text.indexOf(UNRELEASED);
if (start < 0) fail(`${file} has no '${UNRELEASED}' section to release.`);

const bodyStart = start + UNRELEASED.length;
const nextHeading = text.indexOf('\n## ', bodyStart);
const body = text.slice(bodyStart, nextHeading < 0 ? undefined : nextHeading).trim();
if (body === '') fail(`the ${UNRELEASED} section is empty — there is nothing to release.`);

const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  file,
  `${text.slice(0, start)}${UNRELEASED}\n\n## [${version}] - ${date}${text.slice(bodyStart)}`,
);
console.log(`changelog: moved the [Unreleased] notes under '## [${version}] - ${date}' in ${file}.`);
