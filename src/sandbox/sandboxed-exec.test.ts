import { describe, it, expect } from 'vitest';
import type { AgentExecFn, AgentExecResult } from '../agent-cli/codec';
import type { ExecFn, ExecResult } from '../workspace/git-workspace';
import {
  NoneLauncher,
  UnavailableLauncher,
  SandboxUnavailableError,
  type SandboxLauncher,
} from './launcher';
import { BwrapLauncher } from './bwrap';
import { ContainerLauncher } from './container';
import { DEFAULT_CONTAINER_IMAGE } from './policy';
import { withSandboxAgent, withSandboxVerify } from './sandboxed-exec';

const agentResult: AgentExecResult = { stdout: 'ok', stderr: '', code: 0 };
const execResult: ExecResult = { stdout: 'ok', stderr: '', code: 0 };

/**
 * A pathological launcher whose `wrap()` returns a command STRING-EQUAL to its input but tags the
 * args — modelling a future mechanism whose binary name collides with the wrapped command. The
 * passthrough decision must NOT key on string equality, or this would silently fail OPEN.
 */
const collisionLauncher: SandboxLauncher = {
  mode: 'bwrap',
  identity: false,
  available: true,
  wrap: (command, args) => ({ command, args: ['JAILED', ...args] }),
};

describe('withSandboxAgent', () => {
  it('NoneLauncher is a perfect passthrough — original argv, no binary prepended', async () => {
    const seen: string[][] = [];
    const inner: AgentExecFn = async (args) => {
      seen.push(args);
      return agentResult;
    };
    const wrapped = withSandboxAgent('claude', inner, new NoneLauncher(), {
      workspace: '/w',
      network: 'allow',
    });
    await wrapped(['-p', 'hi'], { prompt: 'hi' });
    expect(seen).toEqual([['-p', 'hi']]);
  });

  it('a real launcher rewrites argv into [binary, ...jailArgs] for the neutral spawner', async () => {
    let seen: string[] = [];
    const inner: AgentExecFn = async (args) => {
      seen = args;
      return agentResult;
    };
    const wrapped = withSandboxAgent('claude', inner, new BwrapLauncher(), {
      workspace: '/w',
      network: 'allow',
      home: '/home/me',
    });
    await wrapped(['-p', 'hi'], { prompt: 'hi' });
    expect(seen[0]).toBe('bwrap'); // launcher binary is now argv[0]
    expect(seen.slice(seen.indexOf('--'))).toEqual(['--', 'claude', '-p', 'hi']);
  });

  it('container harness mode re-exports the host env names with -e so the agent can authenticate', async () => {
    let seen: string[] = [];
    const inner: AgentExecFn = async (args) => {
      seen = args;
      return agentResult;
    };
    const wrapped = withSandboxAgent('claude', inner, new ContainerLauncher(), {
      workspace: '/w',
      network: 'allow',
      env: { ANTHROPIC_API_KEY: 'sk-test', PATH: '/usr/bin' },
    });
    await wrapped(['-p', 'hi'], { prompt: 'hi' });
    // The container needs `-e ANTHROPIC_API_KEY` or the agent CLI runs with no credentials.
    const i = seen.indexOf('ANTHROPIC_API_KEY');
    expect(i).toBeGreaterThan(0);
    expect(seen[i - 1]).toBe('-e');
    expect(seen).not.toContain('sk-test'); // value never embedded in argv
  });

  it('bwrap harness mode inherits the env naturally — no -e passthrough needed', async () => {
    let seen: string[] = [];
    const inner: AgentExecFn = async (args) => {
      seen = args;
      return agentResult;
    };
    const wrapped = withSandboxAgent('claude', inner, new BwrapLauncher(), {
      workspace: '/w',
      network: 'allow',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      home: '/home/me',
    });
    await wrapped(['-p', 'hi'], { prompt: 'hi' });
    expect(seen).not.toContain('-e');
    expect(seen).not.toContain('ANTHROPIC_API_KEY');
  });

  it('forwards the input and stdout tap unchanged', async () => {
    let gotPrompt = '';
    const inner: AgentExecFn = async (_args, input) => {
      gotPrompt = input.prompt;
      return agentResult;
    };
    const wrapped = withSandboxAgent('claude', inner, new NoneLauncher(), {
      workspace: '/w',
      network: 'allow',
    });
    await wrapped([], { prompt: 'the-prompt' });
    expect(gotPrompt).toBe('the-prompt');
  });

  it('a non-identity launcher is jailed even when its binary name collides with the command (no fail-open)', async () => {
    let seen: string[] = [];
    const inner: AgentExecFn = async (args) => {
      seen = args;
      return agentResult;
    };
    const wrapped = withSandboxAgent('claude', inner, collisionLauncher, {
      workspace: '/w',
      network: 'allow',
    });
    await wrapped(['-p', 'hi'], { prompt: 'hi' });
    // The rewrite was applied (JAILED present), NOT short-circuited to the original ['-p','hi'].
    expect(seen).toEqual(['claude', 'JAILED', '-p', 'hi']);
  });

  it('threads an egress-proxy allowlist into the launcher (issue #39)', async () => {
    let seen: string[] = [];
    const inner: AgentExecFn = async (args) => {
      seen = args;
      return agentResult;
    };
    const wrapped = withSandboxAgent('claude', inner, new BwrapLauncher(), {
      workspace: '/w',
      network: { allowlist: ['api.anthropic.com'] },
      proxy: { port: 7777 },
      home: '/home/me',
    });
    await wrapped(['-p', 'hi'], { prompt: 'hi' });
    const joined = seen.join(' ');
    expect(joined).toContain('--setenv HTTPS_PROXY http://127.0.0.1:7777');
    expect(joined).not.toContain('--unshare-net');
  });

  it('an UnavailableLauncher reaching the wrapper throws (fail-closed), never an unsandboxed run', () => {
    const inner: AgentExecFn = async () => agentResult;
    const wrapped = withSandboxAgent('claude', inner, new UnavailableLauncher('bwrap missing'), {
      workspace: '/w',
      network: 'allow',
    });
    // The throw is synchronous; both real call sites invoke the exec inside a try/catch, so it
    // becomes a fail-closed crashed-run / FAIL — never an unsandboxed spawn.
    expect(() => wrapped(['-p', 'hi'], { prompt: 'hi' })).toThrow(SandboxUnavailableError);
  });
});

describe('withSandboxVerify', () => {
  it('NoneLauncher is a perfect passthrough — same cmd/args/opts incl. shell', async () => {
    const calls: Array<{ cmd: string; args: string[]; shell: boolean | undefined }> = [];
    const inner: ExecFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, shell: opts.shell });
      return execResult;
    };
    const wrapped = withSandboxVerify(inner, new NoneLauncher(), 'none');
    await wrapped('npm test', [], { cwd: '/w', shell: true });
    expect(calls).toEqual([{ cmd: 'npm test', args: [], shell: true }]);
  });

  it('a real launcher runs a shell verify command through `sh -c` inside the jail and drops shell', async () => {
    let seen: { cmd: string; args: string[]; shell: boolean | undefined } | undefined;
    const inner: ExecFn = async (cmd, args, opts) => {
      seen = { cmd, args, shell: opts.shell };
      return execResult;
    };
    const wrapped = withSandboxVerify(inner, new BwrapLauncher(), 'none', undefined, '/home/me');
    // A multi-token / shell-operator command must reach an interpreter inside the jail — NOT be
    // execve'd as a binary literally named 'echo a && echo b'.
    await wrapped('echo a && echo b', [], { cwd: '/w', shell: true });
    expect(seen?.cmd).toBe('bwrap');
    expect(seen?.shell).toBeUndefined(); // no host shell wrapper around the jail binary
    expect(seen?.args.slice(seen.args.indexOf('--'))).toEqual(['--', 'sh', '-c', 'echo a && echo b']);
    expect(seen?.args).toContain('--unshare-net'); // verifier network 'none' threaded through
  });

  it('container: a shell verify command ends as [..., image, sh, -c, <command>]', async () => {
    let seen: string[] = [];
    const inner: ExecFn = async (_cmd, args) => {
      seen = args;
      return execResult;
    };
    const wrapped = withSandboxVerify(inner, new ContainerLauncher(), 'none');
    await wrapped('echo a && echo b', [], { cwd: '/w', shell: true });
    expect(seen.slice(-4)).toEqual([DEFAULT_CONTAINER_IMAGE, 'sh', '-c', 'echo a && echo b']);
  });

  it('threads the seam network into the launcher (allow ⇒ no --unshare-net)', async () => {
    let seen: string[] = [];
    const inner: ExecFn = async (_cmd, _args, _opts) => {
      return execResult;
    };
    const tap: ExecFn = async (cmd, args, opts) => {
      seen = args;
      return inner(cmd, args, opts);
    };
    const wrapped = withSandboxVerify(tap, new BwrapLauncher(), 'allow', undefined, '/home/me');
    await wrapped('npm test', [], { cwd: '/w', shell: true });
    expect(seen).not.toContain('--unshare-net');
  });

  it('threads an egress-proxy allowlist into the verifier launcher (issue #39)', async () => {
    let seen: string[] = [];
    const tap: ExecFn = async (_cmd, args) => {
      seen = args;
      return execResult;
    };
    const wrapped = withSandboxVerify(
      tap,
      new BwrapLauncher(),
      { allowlist: ['registry.npmjs.org'] },
      { port: 7777 },
      '/home/me',
    );
    await wrapped('npm test', [], { cwd: '/w', shell: true });
    const joined = seen.join(' ');
    expect(joined).toContain('--setenv HTTPS_PROXY http://127.0.0.1:7777');
    expect(joined).not.toContain('--unshare-net');
  });

  it('a non-identity launcher is jailed even when its binary name collides with `sh` (no fail-open)', async () => {
    let seen: { cmd: string; args: string[] } | undefined;
    const inner: ExecFn = async (cmd, args) => {
      seen = { cmd, args };
      return execResult;
    };
    // collisionLauncher.wrap('sh', ['-c','npm test']) → { command:'sh', args:['JAILED','-c','npm test'] }
    const wrapped = withSandboxVerify(inner, collisionLauncher, 'none');
    await wrapped('npm test', [], { cwd: '/w', shell: true });
    expect(seen).toEqual({ cmd: 'sh', args: ['JAILED', '-c', 'npm test'] });
  });

  it('an UnavailableLauncher reaching the verify wrapper throws (fail-closed)', () => {
    const inner: ExecFn = async () => execResult;
    const wrapped = withSandboxVerify(inner, new UnavailableLauncher('bwrap missing'), 'none');
    // Synchronous throw; GitWorkspace.run()'s try/catch turns it into exit 127 (a FAIL).
    expect(() => wrapped('npm test', [], { cwd: '/w', shell: true })).toThrow(
      SandboxUnavailableError,
    );
  });
});
