import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../util/spawn';
import { which } from '../util/which';
import { codecFor, isAgentCli, type AgentCli } from '../agent-cli/registry';
import {
  overlayFromConfig,
  defaultConfigFileReader,
  IMPLICIT_CONFIG_FILENAME,
  HOME_CONFIG_LABEL,
  type ConfigFileReader,
} from './config-file';
import { UsageError } from './flags/tokens';

/**
 * `goaly doctor` (Phase 2.2 of the improvement plan): a READ-ONLY environment report for
 * first-time setup. Every probe the run path spreads across preflight, config loading, and
 * mid-run failures is exercised here up front, with one actionable line per check — so a new
 * user learns what is missing BEFORE spending a token, and `goaly init` can call it before
 * writing a config.
 *
 * It never mutates anything (no file writes, no network beyond the optional --base-url probe)
 * and never throws for an unhealthy environment — the report IS the product. Exit code 0 when
 * goaly can run here in some configuration; 1 only when something goaly cannot work around is
 * broken (Node below the engine floor, or an unparsable config file that would fail every run).
 */

/** The Node major version `package.json#engines` promises. Kept literal so the check is pure. */
export const NODE_ENGINE_FLOOR = 20;

/** The harness CLIs `goaly doctor` probes for on PATH. */
export const BUNDLED_HARNESSES: readonly AgentCli[] = ['claude', 'codex', 'droid', 'pi'];

export type DoctorCommand = {
  /** Optional OpenAI-compatible endpoint to probe (mirrors the run flag `--base-url`). */
  readonly baseUrl: string | undefined;
};

/** Injectable probes so tests never touch the host. Production defaults cover every field. */
export type DoctorProbes = {
  which?: (binary: string) => boolean;
  isGitWorkTree?: (dir: string) => Promise<boolean>;
  /** `process.version`-shaped string, e.g. `v22.1.0`. */
  nodeVersion?: string;
  /** Probe an HTTP endpoint; resolves ok=false (never rejects) on any failure. */
  probeUrl?: (url: string) => Promise<{ ok: boolean; detail: string }>;
  readConfigFile?: ConfigFileReader;
  homeDir?: string;
};

type CheckStatus = 'ok' | 'warn' | 'fail';

type Check = { status: CheckStatus; label: string; detail: string };

const GLYPH: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

async function defaultIsGitWorkTree(dir: string): Promise<boolean> {
  const r = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** Probe `<baseUrl>/models` (the OpenAI-compatible list endpoint); any HTTP answer counts as reachable. */
async function defaultProbeUrl(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const target = `${url.replace(/\/+$/, '')}/models`;
    const res = await fetch(target, { signal: AbortSignal.timeout(5000) });
    return res.status < 500
      ? { ok: true, detail: `reachable (HTTP ${res.status} from /models)` }
      : { ok: false, detail: `server error (HTTP ${res.status} from /models)` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Pure assembly of the report's checks; every environment read goes through `probes`. */
export async function collectChecks(
  cmd: DoctorCommand,
  workspace: string,
  probes: DoctorProbes = {},
): Promise<Check[]> {
  const hasBinary = probes.which ?? which;
  const isGitWorkTree = probes.isGitWorkTree ?? defaultIsGitWorkTree;
  const nodeVersion = probes.nodeVersion ?? process.version;
  const probeUrl = probes.probeUrl ?? defaultProbeUrl;
  const readConfigFile = probes.readConfigFile ?? defaultConfigFileReader;

  const checks: Check[] = [];

  // 1. Node engine floor — goaly is running, but a too-old Node breaks subtle things later.
  const major = Number(/^v(\d+)/.exec(nodeVersion)?.[1] ?? '0');
  checks.push(
    major >= NODE_ENGINE_FLOOR
      ? { status: 'ok', label: 'node', detail: `${nodeVersion} (>= ${NODE_ENGINE_FLOOR} required)` }
      : {
          status: 'fail',
          label: 'node',
          detail: `${nodeVersion} is below the supported floor (>= ${NODE_ENGINE_FLOOR}) — upgrade Node`,
        },
  );

  // 2. git + workspace mode. Not fatal: --workspace-mode file runs without git (ADR 0018).
  if (!hasBinary('git')) {
    checks.push({
      status: 'warn',
      label: 'git',
      detail:
        'not found on PATH — runs will use file mode (--workspace-mode file); install git for ' +
        'diffs, baselines, and worktrees',
    });
  } else if (await isGitWorkTree(workspace)) {
    checks.push({ status: 'ok', label: 'git', detail: `installed; ${workspace} is a git work tree` });
  } else {
    checks.push({
      status: 'warn',
      label: 'git',
      detail:
        `installed, but ${workspace} is not a git repository — runs here will use file mode; ` +
        `run 'git init && git add -A && git commit -m baseline' for full git-mode features`,
    });
  }

  // 3. Harness CLIs on PATH. One is enough; none only blocks CLI-backed harnesses (goaly-code
  //    with an OpenAI-compatible endpoint still works).
  const found: string[] = [];
  const missing: string[] = [];
  for (const harness of BUNDLED_HARNESSES) {
    const command = isAgentCli(harness) ? codecFor(harness).command : harness;
    (hasBinary(command) ? found : missing).push(`${harness} (${command})`);
  }
  if (found.length > 0) {
    checks.push({ status: 'ok', label: 'harnesses', detail: `on PATH: ${found.join(', ')}` });
  }
  if (missing.length > 0) {
    checks.push({
      status: found.length > 0 ? 'ok' : 'warn',
      label: 'harnesses',
      detail:
        `not on PATH: ${missing.join(', ')}` +
        (found.length === 0
          ? ' — install at least one coding-agent CLI, or use --harness goaly-code with an OpenAI-compatible endpoint'
          : ''),
    });
  }

  // 4. Config files: presence AND validity (an invalid one fails every run in this tree).
  for (const [label, file] of [
    [HOME_CONFIG_LABEL, path.join(probes.homeDir ?? os.homedir(), IMPLICIT_CONFIG_FILENAME)],
    [IMPLICIT_CONFIG_FILENAME, path.join(workspace, IMPLICIT_CONFIG_FILENAME)],
  ] as const) {
    const text = await readConfigFile(file);
    if (text === undefined) {
      checks.push({ status: 'ok', label: 'config', detail: `${label}: not present (defaults apply)` });
      continue;
    }
    try {
      overlayFromConfig(JSON.parse(text), label);
      checks.push({ status: 'ok', label: 'config', detail: `${label}: present and valid` });
    } catch (e) {
      checks.push({
        status: 'fail',
        label: 'config',
        detail: `${label}: INVALID — ${e instanceof UsageError ? e.message : String(e)}`,
      });
    }
  }

  // 5. Optional OpenAI-compatible endpoint (only when the user passed/configured --base-url).
  if (cmd.baseUrl !== undefined) {
    const result = await probeUrl(cmd.baseUrl);
    checks.push(
      result.ok
        ? { status: 'ok', label: 'endpoint', detail: `${cmd.baseUrl}: ${result.detail}` }
        : {
            status: 'warn',
            label: 'endpoint',
            detail: `${cmd.baseUrl}: unreachable (${result.detail}) — check the URL, network, and API key`,
          },
    );
  }

  return checks;
}

/**
 * Render the report and return the exit code (0 = goaly can run here, 1 = a hard failure needs
 * fixing first).
 */
export async function runDoctor(
  cmd: DoctorCommand,
  workspace: string,
  out: (s: string) => void,
  probes: DoctorProbes = {},
): Promise<number> {
  const checks = await collectChecks(cmd, workspace, probes);
  out(`goaly doctor — environment report for ${workspace}\n\n`);
  for (const check of checks) {
    out(`  ${GLYPH[check.status]} ${check.label.padEnd(10)} ${check.detail}\n`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  out(
    `\n${
      fails > 0
        ? `${fails} check(s) failed — fix them before running goaly.`
        : warns > 0
          ? `ready with ${warns} warning(s) — goaly can run here.`
          : 'all checks passed — goaly is ready.'
    }\n`,
  );
  return fails > 0 ? 1 : 0;
}
