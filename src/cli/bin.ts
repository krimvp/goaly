/**
 * Executable process bootstrap. The unit-testable logic lives in {@link main} (it returns an exit
 * code and never calls `process.exit`); this file is the thin, untested wrapper that drives the
 * real process. It is the SINGLE CLI entry point — `tsx` runs it directly in dev (`npm run dev`),
 * and esbuild bundles it into `dist/goalorch.js` (with a `#!/usr/bin/env node` shebang) for the
 * standalone, installable binary.
 *
 * We set `process.exitCode` rather than calling `process.exit()` so buffered stdout/stderr is
 * flushed before the event loop drains and the process exits on its own.
 */
import { main } from './main';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
