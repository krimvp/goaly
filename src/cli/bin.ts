/**
 * Executable process bootstrap. The unit-testable logic lives in {@link main} (it returns an exit
 * code and never calls `process.exit`); this file is the thin, untested wrapper that drives the
 * real process. It is the SINGLE CLI entry point — `tsx` runs it directly in dev (`npm run dev`),
 * and esbuild bundles it into `dist/goaly.js` (with a `#!/usr/bin/env node` shebang) for the
 * standalone, installable binary.
 *
 * We set `process.exitCode` rather than calling `process.exit()` so buffered stdout/stderr is
 * flushed before the event loop drains and the process exits on its own.
 */
import { main } from './main';
import { makeCrashHandler } from './crash-guard';

// A fatal error anywhere in the process (an unhandled 'error' event on a stream, an unawaited
// rejection) must reap live child process groups before dying — otherwise a group-spawned agent
// CLI outlives goaly and keeps editing/spending. See crash-guard.ts.
const onFatal = makeCrashHandler();
process.on('uncaughtException', onFatal);
process.on('unhandledRejection', onFatal);

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch(onFatal);
