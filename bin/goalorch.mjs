#!/usr/bin/env -S node --import tsx
// Thin launcher: registers the tsx loader so the TypeScript source runs directly (dev/WSL).
// For distribution, build to dist/ and point this at the compiled entry instead.
import { main } from '../src/cli/main.ts';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
