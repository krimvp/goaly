import { describe, it, expect } from 'vitest';
import { composeDeps } from './compose';
import { makeConfig, InMemoryLogFs } from '../testing/fakes';
import { asRunId } from '../domain/ids';
import { SandboxPolicy } from '../sandbox/policy';
import { UnavailableLauncher, NoneLauncher, type SandboxLauncher } from '../sandbox/launcher';
import { BwrapLauncher } from '../sandbox/bwrap';
import { SandboxUnavailableError } from '../sandbox';

function base(launcher: SandboxLauncher) {
  return {
    harness: 'claude-code' as const,
    workspaceRoot: '/repo',
    runId: asRunId('run-sbx'),
    noLogConsole: true,
    noLogFile: true,
    logFs: new InMemoryLogFs(),
    sandboxLauncher: launcher,
  };
}

describe('composeDeps — sandbox fail-closed (invariant #4)', () => {
  it('REFUSES TO START when the requested mechanism is unavailable (no deps built)', () => {
    expect(() => composeDeps(makeConfig(), base(new UnavailableLauncher('bwrap missing')))).toThrow(
      SandboxUnavailableError,
    );
  });

  it('builds deps normally when a real launcher is available', () => {
    const deps = composeDeps(makeConfig(), base(new BwrapLauncher('/home/me')));
    expect(deps.harness.name).toBe('claude-code');
    expect(deps.workspace).toBeDefined();
  });
});

describe('composeDeps — Option 1 default is byte-for-byte unchanged', () => {
  it('with NoneLauncher the harness adapter still composes (identity passthrough)', () => {
    const deps = composeDeps(makeConfig(), base(new NoneLauncher()));
    expect(deps.harness.name).toBe('claude-code');
  });

  it('the default policy (no sandbox option) never refuses', () => {
    const deps = composeDeps(makeConfig(), {
      harness: 'fake',
      workspaceRoot: '/repo',
      runId: asRunId('run-default'),
      noLogConsole: true,
      noLogFile: true,
      logFs: new InMemoryLogFs(),
      sandbox: SandboxPolicy.parse({}),
    });
    expect(deps.harness.name).toBe('noop');
  });
});
