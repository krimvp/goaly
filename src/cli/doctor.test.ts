import { describe, it, expect } from 'vitest';
import { runDoctor, collectChecks, type DoctorProbes } from './doctor';

/**
 * `goaly doctor` with every probe faked — the report must name the right fix for each broken
 * environment, and the exit code must be 1 only for the failures goaly cannot work around.
 */

const healthy: DoctorProbes = {
  which: () => true,
  isGitWorkTree: async () => true,
  nodeVersion: 'v22.1.0',
  probeUrl: async () => ({ ok: true, detail: 'reachable' }),
  readConfigFile: async () => undefined,
  homeDir: '/fake-home',
};

async function report(
  probes: Partial<DoctorProbes>,
  baseUrl?: string,
): Promise<{ text: string; code: number }> {
  let text = '';
  const code = await runDoctor({ baseUrl }, '/ws', (s) => (text += s), { ...healthy, ...probes });
  return { text, code };
}

describe('goaly doctor', () => {
  it('reports all-clear and exits 0 in a healthy environment', async () => {
    const { text, code } = await report({});
    expect(code).toBe(0);
    expect(text).toContain('all checks passed');
    expect(text).toContain('v22.1.0');
    expect(text).toContain('is a git work tree');
    expect(text).toContain('claude (claude)');
  });

  it('fails (exit 1) when Node is below the engine floor, and says to upgrade', async () => {
    const { text, code } = await report({ nodeVersion: 'v18.19.0' });
    expect(code).toBe(1);
    expect(text).toContain('below the supported floor');
    expect(text).toContain('upgrade Node');
  });

  it('warns with the git-init recipe when the workspace is not a repo (file mode still works)', async () => {
    const { text, code } = await report({ isGitWorkTree: async () => false });
    expect(code).toBe(0); // file mode exists — not fatal
    expect(text).toContain('not a git repository');
    expect(text).toContain('git init');
    expect(text).toContain('file mode');
  });

  it('warns when git itself is missing from PATH', async () => {
    const { text, code } = await report({ which: (bin) => bin !== 'git' });
    expect(code).toBe(0);
    expect(text).toContain('install git');
  });

  it('suggests goaly-code when no harness CLI is installed', async () => {
    const { text, code } = await report({ which: (bin) => bin === 'git' });
    expect(code).toBe(0);
    expect(text).toContain('install at least one coding-agent CLI');
    expect(text).toContain('goaly-code');
  });

  it('lists found and missing harnesses separately when some are installed', async () => {
    const { text } = await report({ which: (bin) => bin === 'git' || bin === 'claude' });
    expect(text).toContain('on PATH: claude (claude)');
    expect(text).toContain('not on PATH: codex (codex)');
  });

  it('fails on an INVALID config file with the parse error, but accepts a valid one', async () => {
    const invalid = await report({
      readConfigFile: async (p) => (p.includes('/ws/') ? '{ "no-such-flag": 1 }' : undefined),
    });
    expect(invalid.code).toBe(1);
    expect(invalid.text).toContain('INVALID');

    const valid = await report({
      readConfigFile: async (p) => (p.includes('/ws/') ? '{ "harness": "codex" }' : undefined),
    });
    expect(valid.code).toBe(0);
    expect(valid.text).toContain('.goalyrc: present and valid');
  });

  it('reads the home config from the injected homeDir', async () => {
    const { text, code } = await report({
      readConfigFile: async (p) => (p.startsWith('/fake-home/') ? 'not json' : undefined),
    });
    expect(code).toBe(1);
    expect(text).toContain('~/.goalyrc: INVALID');
  });

  it('probes --base-url only when given, and reports unreachable as a warning', async () => {
    const silent = await report({});
    expect(silent.text).not.toContain('endpoint');

    const down = await report(
      { probeUrl: async () => ({ ok: false, detail: 'ECONNREFUSED' }) },
      'http://localhost:11434/v1',
    );
    expect(down.code).toBe(0);
    expect(down.text).toContain('unreachable');
    expect(down.text).toContain('ECONNREFUSED');

    const up = await report({}, 'http://localhost:11434/v1');
    expect(up.text).toContain('http://localhost:11434/v1: reachable');
  });

  it('collectChecks never throws for a probe that rejects unreachability gracefully', async () => {
    const checks = await collectChecks({ baseUrl: 'http://x' }, '/ws', {
      ...healthy,
      probeUrl: async () => ({ ok: false, detail: 'timeout' }),
    });
    expect(checks.some((c) => c.status === 'warn')).toBe(true);
  });
});
