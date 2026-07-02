// Build script: bundle the project for distribution with esbuild.
//
// Two artifacts land in dist/ (run `npm run build`, which also emits .d.ts via tsc):
//   1. dist/goaly.js — the standalone CLI. Self-contained (deps incl. zod inlined) with a
//      `#!/usr/bin/env node` shebang and the executable bit, so a global install drops a `goaly`
//      binary that runs with nothing but Node on PATH.
//   2. dist/index.js     — the embeddable library entry. Deps are kept EXTERNAL so a consumer
//      dedupes its own zod; pairs with the tsc-generated dist/index.d.ts.
//
// We must bundle (not just `tsc` emit) because the source uses extensionless imports under
// `moduleResolution: Bundler`, which Node's ESM loader cannot resolve at runtime.

import { build } from 'esbuild';
import { chmod, cp } from 'node:fs/promises';

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
  entryPoints: { goaly: 'src/cli/bin.ts' },
  outdir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
});
await chmod('dist/goaly.js', 0o755);

// 2) Embeddable library — keep node_modules deps external for consumers to dedupe.
await build({
  ...shared,
  entryPoints: { index: 'src/index.ts' },
  outdir: 'dist',
  packages: 'external',
});

// 3) The goaly ui SPA — a BROWSER bundle. preact + htm are devDependencies inlined here as static
//    assets, so the published package's runtime deps stay zod-only (`dist/goaly.js` never imports
//    them). Served by `goaly ui` from dist/ui next to the CLI bundle.
await build({
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  logLevel: 'info',
  entryPoints: { app: 'src/ui/web/app.ts' },
  outdir: 'dist/ui',
});
await cp('src/ui/web/index.html', 'dist/ui/index.html');
await cp('src/ui/web/style.css', 'dist/ui/style.css');

process.stdout.write('build: wrote dist/goaly.js (CLI), dist/index.js (library), dist/ui/ (web UI)\n');
