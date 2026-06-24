import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Hermetic HOME for the whole suite. Config resolution reads a home-level `~/.goalyrc`
 * (`src/cli/config-file.ts`) via `os.homedir()`, which on POSIX honours `$HOME`. A developer's
 * real `~/.goalyrc` must never bleed into tests that rely on the built-in defaults, so point
 * HOME/USERPROFILE at a fresh empty temp dir before any test runs. Tests that exercise the home
 * layer pass an explicit `homeDir` to `loadConfig` instead of depending on this.
 */
const emptyHome = mkdtempSync(path.join(os.tmpdir(), 'goaly-test-home-'));
process.env.HOME = emptyHome;
process.env.USERPROFILE = emptyHome;
