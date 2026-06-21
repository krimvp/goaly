// Build script: bundle the project for distribution with esbuild.
//
// Two artifacts land in dist/ (run `npm run build`, which also emits .d.ts via tsc):
//   1. dist/goalorch.js — the standalone CLI. Self-contained (deps incl. zod inlined) with a
//      `#!/usr/bin/env node` shebang and the executable bit, so a global install drops a `goalorch`
//      binary that runs with nothing but Node on PATH.
//   2. dist/index.js     — the embeddable library entry. Deps are kept EXTERNAL so a consumer
//      dedupes its own zod; pairs with the tsc-generated dist/index.d.ts.
//
// We must bundle (not just `tsc` emit) because the source uses extensionless imports under
// `moduleResolution: Bundler`, which Node's ESM loader cannot resolve at runtime.

import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

// 1) Standalone CLI — bundle everything (Node builtins stay external automatically).
await build({
  ...shared,
  entryPoints: { goalorch: 'src/cli/bin.ts' },
  outdir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
});
await chmod('dist/goalorch.js', 0o755);

// 2) Embeddable library — keep node_modules deps external for consumers to dedupe.
await build({
  ...shared,
  entryPoints: { index: 'src/index.ts' },
  outdir: 'dist',
  packages: 'external',
});

process.stdout.write('build: wrote dist/goalorch.js (CLI) and dist/index.js (library)\n');
