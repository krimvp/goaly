/**
 * Strip credential-looking variables from an environment before it is handed to the verify command.
 * The verifier runs worker-authored code on the host every iteration; in `--autonomous`
 * `--generate` that code is entirely model-authored. Leaking the parent process's secrets (API keys,
 * cloud credentials, tokens) into it is an exfiltration channel that has nothing to do with checking
 * whether the goal was met. We cannot sandbox the host portably without new deps, but we can deny the
 * verify command the ambient secrets it never needs.
 *
 * Conservative and fail-safe: it errs toward DROPPING (a legitimate `npm test` needs PATH/HOME/CI
 * flags, not AWS keys), and leaves non-secret variables — PATH, HOME, LANG, the toolchain's own
 * config — intact so ordinary test commands keep working.
 */

/** Substrings that, anywhere in a variable NAME (case-insensitive), mark it as credential-bearing. */
const SECRET_SUBSTRINGS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'APIKEY',
  'API_KEY',
  'ACCESS_KEY',
  'PRIVATE_KEY',
  'SESSION',
  'COOKIE',
  'AUTH',
];

/** Name prefixes for well-known credential-bearing vendors, dropped whole. */
const SECRET_PREFIXES = [
  'AWS_',
  'GOOGLE_',
  'GCP_',
  'AZURE_',
  'GH_',
  'GITHUB_',
  'OPENAI',
  'ANTHROPIC',
  'HF_',
  'SLACK_',
  'STRIPE_',
  'TWILIO_',
  'DOCKER_',
  'CLOUDFLARE_',
  'NPM_TOKEN',
];

/** Whether a single env-var name looks like it carries a secret and should be dropped. */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SECRET_SUBSTRINGS.some((s) => upper.includes(s))) return true;
  return SECRET_PREFIXES.some((p) => upper.startsWith(p));
}

/** Return a copy of `env` with credential-looking variables removed. Pure; never mutates input. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSecretEnvName(name)) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}

/**
 * Standard per-user install directories (relative to `$HOME`) that toolchain installers drop binaries
 * into — rustup → `~/.cargo/bin`, pip/pipx --user → `~/.local/bin`, go → `~/go/bin`, etc. goaly spawns
 * the verifier from a copy of its OWN `process.env` taken at startup, so a tool the AGENT installs
 * mid-run (the default `--install-missing-tools` path) would otherwise be invisible to the later verify
 * subprocess even though it's on disk. Appending these (lowest priority, so system tools still win)
 * makes an agent-installed toolchain discoverable without depending on the agent editing a shell rc.
 */
const USER_TOOL_BIN_DIRS = [
  '.cargo/bin',
  '.local/bin',
  '.local/share/pnpm',
  'go/bin',
  '.deno/bin',
  '.bun/bin',
  '.npm-global/bin',
  'bin',
];

/**
 * Return a copy of `env` whose PATH also includes the standard per-user tool bin dirs (see
 * `USER_TOOL_BIN_DIRS`). Pure; never mutates input. A no-op when `HOME` is unset. Entries already on
 * PATH are not duplicated; new entries are APPENDED so a system binary of the same name still wins.
 */
export function augmentToolPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env.HOME;
  if (home === undefined || home.length === 0) return { ...env };
  const sep = process.platform === 'win32' ? ';' : ':';
  const existing = (env.PATH ?? '').split(sep).filter((p) => p.length > 0);
  const have = new Set(existing);
  const extra = USER_TOOL_BIN_DIRS.map((d) => `${home}/${d}`).filter((d) => !have.has(d));
  return { ...env, PATH: [...existing, ...extra].join(sep) };
}
