/**
 * Docs-sync gate (improvement plan 5.2): every flag the CLI documents in `USAGE` — the user-facing
 * contract — must also appear in `docs/reference.md`, and so must every config-file key. Run via
 * `npm run check:docs` (tsx) and in CI, so a new flag cannot ship without reference documentation.
 *
 * The exclusion list mirrors the config drift test's: flag-shaped tokens in USAGE that are another
 * tool's flags or prose globs, not goaly flags.
 */
import { readFileSync } from 'node:fs';
import { USAGE } from '../src/cli/usage';
import { CONFIG_FILE_KEYS } from '../src/cli/config-file';

const NOT_A_FLAG = new Set(['auto', 'rm', 'json', 'stuck-', 'baseline-style']);

const reference = readFileSync('docs/reference.md', 'utf8');

const documentedFlags = [
  ...new Set(
    [...USAGE.matchAll(/--([a-z][a-z0-9-]*)/g)]
      .map((m) => m[1] as string)
      .filter((f) => !NOT_A_FLAG.has(f)),
  ),
].sort();

const missingFlags = documentedFlags.filter((flag) => !reference.includes(`--${flag}`));
const missingKeys = [...CONFIG_FILE_KEYS].filter(
  // A config key mirrors its flag's kebab-case name, so the flag's presence covers it.
  (key) => !reference.includes(`--${key}`) && !reference.includes(`\`${key}\``),
);

const failures = [
  ...missingFlags.map((f) => `--${f} is in USAGE but not in docs/reference.md`),
  ...missingKeys.map((k) => `config key '${k}' is not documented in docs/reference.md`),
];

if (failures.length > 0) {
  console.error('docs-sync gate failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(
  `docs-sync gate ok (${documentedFlags.length} flags, ${CONFIG_FILE_KEYS.length} config keys all referenced)`,
);
