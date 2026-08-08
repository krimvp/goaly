/**
 * Generate `goalyrc.schema.json` (repo root) from the Zod-derived builder (improvement plan 3.2).
 * Run via `npm run gen:schema` (tsx); `npm run build` runs it first so the checked-in file and the
 * one shipped in `dist/` can never lag the code on a release. The drift test in
 * `src/cli/config-schema.test.ts` fails the suite when this file is stale.
 */
import { writeFileSync } from 'node:fs';
import { buildConfigJsonSchema } from '../src/cli/config-schema';

writeFileSync('goalyrc.schema.json', `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`);
process.stdout.write('wrote goalyrc.schema.json\n');
