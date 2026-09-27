/**
 * Docs-sync gate (improvement plan 5.2): every flag the CLI documents in `USAGE` — the user-facing
 * contract — must also appear in `docs/reference.md`, and so must every config-file key. Run via
 * `npm run check:docs` (tsx) and in CI, so a new flag cannot ship without reference documentation.
 *
 * The exclusion list mirrors the config drift test's: flag-shaped tokens in USAGE that are another
 * tool's flags or prose globs, not goaly flags.
 *
 * A second check keeps `docs/README.md` (the router) complete: every top-level document and every
 * `*.md` directly under `docs/` must be linked from it, so a new document cannot ship unreachable.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { documentedFlagNames } from '../src/cli/help';
import { CONFIG_FILE_KEYS } from '../src/cli/config-file';
import { BUILTIN_PRESETS } from '../src/cli/presets';

const reference = readFileSync('docs/reference.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const landing = readFileSync('docs/index.html', 'utf8');

const documentedFlags = documentedFlagNames();

const missingFlags = documentedFlags.filter((flag) => !reference.includes(`--${flag}`));
const missingKeys = [...CONFIG_FILE_KEYS].filter(
  // A config key mirrors its flag's kebab-case name, so the flag's presence covers it.
  (key) => !reference.includes(`--${key}`) && !reference.includes(`\`${key}\``),
);

const router = readFileSync('docs/README.md', 'utf8');
const routed = [
  'README.md',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CONTEXT.md',
  'CHANGELOG.md',
  ...readdirSync('docs')
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => `docs/${f}`),
];
const orphans = routed.filter(
  (doc) => !router.includes(doc) && !router.includes(`](${basename(doc)})`),
);

const defaultPreset = BUILTIN_PRESETS.default?.overlay;
const defaultTokens = Number(defaultPreset?.['budget-tokens']);
const defaultWallMs = Number(defaultPreset?.['budget-wall-ms']);
const formatNumber = (value: number): string => value.toLocaleString('en-US');
const defaultBudgetPhrase = `${formatNumber(defaultTokens)} tokens and ${formatNumber(defaultWallMs)} ms`;
const requiredAssuranceClaims: [string, string, string][] = [
  ['README.md', readme, 'semantic correctness'],
  ['README.md', readme, 'check quality'],
  ['README.md', readme, '7,200,000 ms'],
  ['docs/reference.md', reference, 'semantic correctness'],
  ['docs/reference.md', reference, 'requested sample count N'],
  ['docs/reference.md', reference, defaultBudgetPhrase],
  ['docs/reference.md', reference, 'does not enable the Goaly OS sandbox'],
  ['docs/index.html', landing, 'semantic correctness'],
  ['docs/index.html', landing, defaultBudgetPhrase],
  ['docs/index.html', landing, 'no Goaly OS sandbox'],
];
const missingAssuranceClaims = requiredAssuranceClaims.filter(([, content, phrase]) =>
  !content.replace(/\s+/g, ' ').includes(phrase),
);

const failures = [
  ...missingFlags.map((f) => `--${f} is in USAGE but not in docs/reference.md`),
  ...missingKeys.map((k) => `config key '${k}' is not documented in docs/reference.md`),
  ...orphans.map((d) => `${d} is not linked from docs/README.md (the docs router)`),
  ...missingAssuranceClaims.map(([name, , phrase]) => `${name} is missing high-risk product wording: '${phrase}'`),
];

if (failures.length > 0) {
  console.error('docs-sync gate failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(
  `docs-sync gate ok (${documentedFlags.length} flags, ${CONFIG_FILE_KEYS.length} config keys all referenced; ${routed.length} docs routed)`,
);
