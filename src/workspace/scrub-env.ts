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
