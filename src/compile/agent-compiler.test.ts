import { describe, it, expect } from 'vitest';
import { ContractHash } from '../domain/ids';
import { FakeLlm, type LlmCompletion, type LlmProvider } from '../llm/provider';
import { makeConfig } from '../testing/fakes';
import {
  AgentCompiler,
  isVacuousCommand,
  looksLikeLlmTimeout,
  referencesOutOfRepoPath,
  referencesNetworkFetch,
} from './agent-compiler';

/** An LLM whose authoring call always rejects — to exercise the timeout-hint path (follow-on G). */
class ThrowingLlm implements LlmProvider {
  readonly name = 'throwing';
  constructor(private readonly error: Error) {}
  complete(): Promise<LlmCompletion> {
    return Promise.reject(this.error);
  }
}

describe('AgentCompiler — existing verifier', () => {
  it('builds one deterministic rung equal to the ref and a valid contractHash', async () => {
    // Arrange
    const llm = new FakeLlm([]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'existing', ref: 'npm test' } });

    // Act
    const contract = await compiler.compile(config);

    // Assert
    expect(contract.rungs).toEqual([{ kind: 'deterministic', command: 'npm test' }]);
    expect(() => ContractHash.parse(contract.contractHash)).not.toThrow();
    expect(contract.generatedFiles).toEqual([]);
    expect(llm.requests).toHaveLength(0); // no LLM call for existing
  });

  it('derives requiredTools heuristically from the verify command (no LLM call)', async () => {
    const compiler = new AgentCompiler({ llm: new FakeLlm([]) });
    const config = makeConfig({
      verifier: { kind: 'existing', ref: 'cargo fmt -- --check && cargo test' },
    });
    const contract = await compiler.compile(config);
    expect(contract.requiredTools).toEqual(['cargo']);
  });

  it('a tool-less verify command (only builtins) freezes an empty requiredTools', async () => {
    const compiler = new AgentCompiler({ llm: new FakeLlm([]) });
    const config = makeConfig({ verifier: { kind: 'existing', ref: 'true' } });
    const contract = await compiler.compile(config);
    expect(contract.requiredTools).toEqual([]);
  });

  it('carries --setup-cmd into the contract on the existing-command path (no LLM call)', async () => {
    const llm = new FakeLlm([]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({
      verifier: { kind: 'existing', ref: 'npm test' },
      setupCmd: 'npm ci',
    });
    const contract = await compiler.compile(config);
    expect(contract.setup).toBe('npm ci');
    expect(llm.requests).toHaveLength(0);
  });

  it('adds a judge rung when a non-empty rubric is present', async () => {
    // Arrange
    const llm = new FakeLlm([]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({
      verifier: { kind: 'existing', ref: 'npm test' },
      rubric: 'output must be clean',
      judge: { quorum: 5, confidenceFloor: 0.8 },
    });

    // Act
    const contract = await compiler.compile(config);

    // Assert
    expect(contract.rungs).toHaveLength(2);
    expect(contract.rungs[0]).toEqual({ kind: 'deterministic', command: 'npm test' });
    expect(contract.rungs[1]).toEqual({
      kind: 'judge',
      rubric: 'output must be clean',
      quorum: 5,
      confidenceFloor: 0.8,
    });
    expect(contract.rubric).toBe('output must be clean');
  });

  it('inserts the artifact-running smoke command as a deterministic rung before the judge (issue #53)', async () => {
    const llm = new FakeLlm([]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({
      verifier: { kind: 'existing', ref: 'npm test' },
      smoke: 'node smoke.mjs',
      rubric: 'looks good',
    });

    const contract = await compiler.compile(config);

    expect(contract.rungs).toHaveLength(3);
    expect(contract.rungs[0]).toEqual({ kind: 'deterministic', command: 'npm test' });
    expect(contract.rungs[1]).toEqual({
      kind: 'deterministic',
      command: 'node smoke.mjs',
      label: 'smoke',
    });
    expect(contract.rungs[2]?.kind).toBe('judge');
  });
});

describe('AgentCompiler — generate verifier', () => {
  it('authors a deterministic rung from command, writes files, and records generatedFiles', async () => {
    // Arrange
    const writes: Array<{ path: string; content: string }> = [];
    const writeFile = async (relPath: string, content: string): Promise<void> => {
      writes.push({ path: relPath, content });
    };
    const llm = new FakeLlm([
      JSON.stringify({
        command: 'vitest run parser.test.ts',
        rubric: '',
        files: [{ path: 'parser.test.ts', content: 'test("x", () => {})' }],
      }),
    ]);
    const compiler = new AgentCompiler({ llm, writeFile });
    const config = makeConfig({ verifier: { kind: 'generate', intent: 'add a parser test' } });

    // Act
    const contract = await compiler.compile(config);

    // Assert
    expect(contract.rungs).toEqual([
      { kind: 'deterministic', command: 'vitest run parser.test.ts' },
    ]);
    expect(contract.generatedFiles).toHaveLength(1);
    expect(contract.generatedFiles[0]?.path).toBe('parser.test.ts');
    expect(contract.generatedFiles[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(writes).toEqual([
      { path: 'parser.test.ts', content: 'test("x", () => {})' },
    ]);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.temperature).toBe(0);
  });

  it('instructs the author that generated files are verification-only and the bar must fail on an empty tree', async () => {
    // Guard against the compiler authoring the SOLUTION into the frozen verification set (the deadlock:
    // the worker can't edit a frozen file, and its real work then reads as no-diff).
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));
    const system = llm.requests[0]?.system ?? '';
    expect(system).toMatch(/VERIFICATION ONLY/);
    expect(system).toMatch(/NEVER author the implementation/i);
    expect(system).toMatch(/FAIL on the CURRENT tree/);
  });

  it('freezes the LLM-authored requiredTools manifest into the contract', async () => {
    const llm = new FakeLlm([
      JSON.stringify({ command: 'cargo test', rubric: '', requiredTools: ['cargo', 'rustup'] }),
    ]);
    const compiler = new AgentCompiler({ llm });
    const contract = await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));
    expect(contract.requiredTools).toEqual(['cargo', 'rustup']);
  });

  it('falls back to the heuristic when the LLM omits requiredTools', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'pytest -q', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    const contract = await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));
    expect(contract.requiredTools).toEqual(['pytest']);
  });

  it('freezes the LLM-authored setup command into the contract (Fix #1)', async () => {
    const llm = new FakeLlm([
      JSON.stringify({ command: 'npm test', rubric: '', setup: 'npm ci' }),
    ]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });
    const contract = await compiler.compile(config);
    expect(contract.setup).toBe('npm ci');
  });

  it('--setup-cmd overrides the LLM-authored setup command', async () => {
    const llm = new FakeLlm([
      JSON.stringify({ command: 'npm test', rubric: '', setup: 'npm ci' }),
    ]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' }, setupCmd: 'pnpm install --frozen-lockfile' });
    const contract = await compiler.compile(config);
    expect(contract.setup).toBe('pnpm install --frozen-lockfile');
  });

  it('--no-setup drops the authored setup command entirely', async () => {
    const llm = new FakeLlm([
      JSON.stringify({ command: 'npm test', rubric: '', setup: 'npm ci' }),
    ]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' }, noSetup: true });
    const contract = await compiler.compile(config);
    expect(contract.setup).toBeUndefined();
  });

  it('treats a blank authored setup as no setup', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '', setup: '   ' })]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });
    const contract = await compiler.compile(config);
    expect(contract.setup).toBeUndefined();
  });

  it('appends a judge rung when the generated rubric is non-empty', async () => {
    // Arrange
    const llm = new FakeLlm([
      JSON.stringify({ command: 'npm run check', rubric: 'must be idiomatic' }),
    ]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({
      verifier: { kind: 'generate' },
      judge: { quorum: 2, confidenceFloor: 0.5 },
    });

    // Act
    const contract = await compiler.compile(config);

    // Assert
    expect(contract.rungs).toHaveLength(2);
    expect(contract.rungs[1]).toEqual({
      kind: 'judge',
      rubric: 'must be idiomatic',
      quorum: 2,
      confidenceFloor: 0.5,
    });
  });

  it('tolerates JSON surrounded by prose / fences', async () => {
    // Arrange
    const llm = new FakeLlm([
      'Sure! Here is the verification:\n```json\n' +
        JSON.stringify({ command: 'make test', rubric: '' }) +
        '\n```\nHope that helps.',
    ]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });

    // Act
    const contract = await compiler.compile(config);

    // Assert
    expect(contract.rungs).toEqual([{ kind: 'deterministic', command: 'make test' }]);
  });

  it('rejects when the LLM returns garbage', async () => {
    // Arrange
    const llm = new FakeLlm(['this is not json at all, sorry']);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });

    // Act + Assert
    await expect(compiler.compile(config)).rejects.toThrow();
  });

  it('rejects when the JSON is missing the required command', async () => {
    // Arrange
    const llm = new FakeLlm([JSON.stringify({ rubric: 'no command here' })]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });

    // Act + Assert
    await expect(compiler.compile(config)).rejects.toThrow();
  });

  it('threads Seal revise feedback into the authoring prompt', async () => {
    // Arrange
    const llm = new FakeLlm([JSON.stringify({ command: 'npm run check', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });

    // Act
    await compiler.compile(config, 'be stricter about error handling');

    // Assert
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.prompt).toContain('Reviewer feedback');
    expect(llm.requests[0]?.prompt).toContain('be stricter about error handling');
  });
});

describe('isVacuousCommand', () => {
  it('flags trivially-passing no-ops', () => {
    for (const cmd of ['true', ':', 'exit 0', 'exit', '  true  ', 'true; :', 'true && exit 0', '']) {
      expect(isVacuousCommand(cmd)).toBe(true);
    }
  });

  it('passes real test/check commands through', () => {
    for (const cmd of ['npm test', 'vitest run', 'make check', 'true && npm test', './run.sh; exit 0']) {
      expect(isVacuousCommand(cmd)).toBe(false);
    }
  });
});

describe('AgentCompiler — vacuous generated command', () => {
  it('refuses to freeze a contract whose authored command trivially passes', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'true', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });

    await expect(compiler.compile(config)).rejects.toThrow(/vacuous/);
  });

  it('still accepts a user-supplied existing "true" command (informed choice)', async () => {
    const llm = new FakeLlm([]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'existing', ref: 'true' } });

    const contract = await compiler.compile(config);

    expect(contract.rungs).toEqual([{ kind: 'deterministic', command: 'true' }]);
  });
});

describe('referencesOutOfRepoPath (issue #55)', () => {
  it('flags commands that reach into an OS temp dir', () => {
    for (const cmd of [
      'bash /tmp/goaly-phase-verify.sh',
      'sh /var/tmp/x.sh',
      'node /var/folders/ab/script.js',
      './run.sh && /tmp/helper',
    ]) {
      expect(referencesOutOfRepoPath(cmd)).toBe(true);
    }
  });

  it('passes normal in-repo commands through', () => {
    for (const cmd of ['npm test', 'vitest run test/wave.test.js', 'make check', './scripts/tmp.sh']) {
      expect(referencesOutOfRepoPath(cmd)).toBe(false);
    }
  });
});

describe('referencesNetworkFetch (offline verify command)', () => {
  it('flags verify commands that fetch/install at run time', () => {
    for (const cmd of [
      'npx --yes vitest run test/x.test.ts',
      'npx -y jest',
      'uvx ruff check',
      'pipx run pytest',
      'npm ci && npm test',
      'pip install -r requirements.txt && pytest',
      'go mod download && go test ./...',
      'cargo install cargo-nextest; cargo nextest run',
    ]) {
      expect(referencesNetworkFetch(cmd)).toBe(true);
    }
  });

  it('passes offline runner invocations through (a locally-installed bar)', () => {
    for (const cmd of [
      'npm test',
      'npx --no-install vitest run test/x.test.ts',
      'npx vitest run', // npx of a locally-installed pkg is offline
      'node ./node_modules/.bin/vitest run',
      'pytest -q',
      'go test ./...',
      'cargo test',
      'make check',
    ]) {
      expect(referencesNetworkFetch(cmd)).toBe(false);
    }
  });
});

describe('AgentCompiler — network-fetching generated command', () => {
  it('refuses to freeze a verify command that fetches at run time (→ self-correctable COMPILE_FAILED)', async () => {
    const llm = new FakeLlm([
      JSON.stringify({ command: 'npx --yes vitest run verification/x.test.ts', rubric: 'r' }),
    ]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'generate' } });

    await expect(compiler.compile(config)).rejects.toThrow(/fetches\/installs at verify time/);
  });
});

describe('AgentCompiler — rubric guardrails (issue #55)', () => {
  it('carries the runnable-bar guardrails in the authoring system prompt', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));

    const system = llm.requests[0]?.system ?? '';
    expect(system).toContain('EXISTING tooling');
    expect(system).toContain('/tmp');
    expect(system).toContain('RELATIVE path');
    expect(system).toContain('OFFLINE');
  });

  it('refuses (fail-closed) an authored command that references an out-of-repo path', async () => {
    const llm = new FakeLlm([
      JSON.stringify({ command: 'bash /tmp/goaly-phase-verify.sh', rubric: '' }),
    ]);
    const compiler = new AgentCompiler({ llm });

    await expect(compiler.compile(makeConfig({ verifier: { kind: 'generate' } }))).rejects.toThrow(
      /out-of-repo path/,
    );
  });

  it('threads --verify-dir guidance into the authoring prompt (issue #52)', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    const compiler = new AgentCompiler({ llm, verifyDir: 'test' });
    await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));

    expect(llm.requests[0]?.prompt).toContain("'test/'");
  });
});

describe('looksLikeLlmTimeout (follow-on G)', () => {
  it('matches CLI-provider and HTTP-abort timeout phrasings', () => {
    expect(looksLikeLlmTimeout('LLM CLI cli:claude timed out')).toBe(true);
    expect(looksLikeLlmTimeout('chat-completions failed after 3 attempts: The operation was aborted')).toBe(true);
    expect(looksLikeLlmTimeout('request timeout')).toBe(true);
  });

  it('does not match ordinary authoring errors', () => {
    expect(looksLikeLlmTimeout('LLM response contained no JSON object')).toBe(false);
    expect(looksLikeLlmTimeout('HTTP 401: unauthorized')).toBe(false);
  });
});

describe('AgentCompiler — authoring timeout hint (follow-on G)', () => {
  it('appends a raise --llm-timeout-ms hint when the authoring LLM call times out', async () => {
    const compiler = new AgentCompiler({ llm: new ThrowingLlm(new Error('LLM CLI cli:claude timed out')) });
    const config = makeConfig({ verifier: { kind: 'generate' } });
    // The reason flows verbatim into COMPILE_FAILED (driver: errorMessage(e)); assert on the message.
    await expect(compiler.compile(config)).rejects.toThrow(/--llm-timeout-ms/);
    await expect(compiler.compile(config)).rejects.toThrow(/timed out/);
  });

  it('leaves a non-timeout authoring error unchanged (no spurious timeout hint)', async () => {
    const compiler = new AgentCompiler({ llm: new ThrowingLlm(new Error('HTTP 401: unauthorized')) });
    const config = makeConfig({ verifier: { kind: 'generate' } });
    const err = await compiler.compile(config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('--llm-timeout-ms');
  });
});

describe('AgentCompiler — anti-reimplementation usage gate', () => {
  const buildAndUse = async () => ({ buildAndUse: true, targetArtifact: 'World', reason: 'r' });
  const notBuildAndUse = async () => ({ buildAndUse: false, targetArtifact: null, reason: 'r' });

  it('carries the usage/anti-reimplementation steering in the authoring system prompt', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));
    const system = llm.requests[0]?.system ?? '';
    expect(system).toContain('usageAssertion');
    expect(system).toMatch(/reimplementation/i);
    expect(system).toMatch(/spies the real API|instruments/i);
  });

  it('rejects a build-and-use contract that declares no usage assertion (→ COMPILE_FAILED)', async () => {
    const llm = new FakeLlm([
      JSON.stringify({
        command: 'python -m pytest tests/t.py',
        rubric: 'solvers correct',
        files: [{ path: 'tests/t.py', content: 'def test_orbit(): assert solve()' }],
      }),
    ]);
    const compiler = new AgentCompiler({ llm, writeFile: async () => {}, classifyShape: buildAndUse });
    await expect(
      compiler.compile(makeConfig({ verifier: { kind: 'generate' } })),
    ).rejects.toThrow(/BUILD-AND-USE/);
  });

  it('rejects a build-and-use contract whose declared symbol is not embedded in a frozen file', async () => {
    const llm = new FakeLlm([
      JSON.stringify({
        command: 'python -m pytest tests/t.py',
        rubric: 'r',
        files: [{ path: 'tests/t.py', content: 'def test(): assert solve()' }],
        usageAssertion: { targetSymbols: ['World.step'], description: 'spy step' },
      }),
    ]);
    const compiler = new AgentCompiler({ llm, writeFile: async () => {}, classifyShape: buildAndUse });
    await expect(
      compiler.compile(makeConfig({ verifier: { kind: 'generate' } })),
    ).rejects.toThrow(/not referenced/);
  });

  it('accepts a build-and-use contract with a usage assertion embedded in a frozen file', async () => {
    const llm = new FakeLlm([
      JSON.stringify({
        command: 'python -m pytest tests/t.py',
        rubric: 'r',
        files: [
          {
            path: 'tests/t.py',
            content: 'orig = World.step\ncalls = []\nWorld.step = lambda *a: calls.append(1)\nassert calls',
          },
        ],
        usageAssertion: { targetSymbols: ['World.step'], description: 'spy World.step, assert invoked' },
      }),
    ]);
    const compiler = new AgentCompiler({ llm, writeFile: async () => {}, classifyShape: buildAndUse });
    const contract = await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));
    expect(contract.generatedFiles).toHaveLength(1);
  });

  it('does not require a usage assertion when the goal is not build-and-use', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    const compiler = new AgentCompiler({ llm, classifyShape: notBuildAndUse });
    const contract = await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));
    expect(contract.rungs[0]).toEqual({ kind: 'deterministic', command: 'npm test' });
  });

  it('skips the gate entirely when no classifier is injected (backward-compatible default)', async () => {
    // No classifyShape → the gate is off, so even a build-and-use-shaped goal with no usageAssertion
    // compiles. Real runs wire the classifier in compose.ts; this keeps the scripted unit tests pure.
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    const contract = await compiler.compile(
      makeConfig({ verifier: { kind: 'generate', intent: 'build an engine and use it' } }),
    );
    expect(contract.rungs).toHaveLength(1);
    expect(llm.requests).toHaveLength(1); // only the authoring call, no shape call
  });
});

describe('AgentCompiler — feedback on an existing verifier', () => {
  it('ignores Seal feedback (no LLM call, deterministic recompile)', async () => {
    // Arrange
    const llm = new FakeLlm([]);
    const compiler = new AgentCompiler({ llm });
    const config = makeConfig({ verifier: { kind: 'existing', ref: 'npm test' } });

    // Act
    const contract = await compiler.compile(config, 'this feedback cannot steer a fixed command');

    // Assert
    expect(llm.requests).toHaveLength(0);
    expect(contract.rungs).toEqual([{ kind: 'deterministic', command: 'npm test' }]);
  });
});

describe('AgentCompiler — authoring session-resume (revise rounds)', () => {
  const genConfig = makeConfig({ verifier: { kind: 'generate' } });
  const authored = (command: string): string => JSON.stringify({ command, rubric: '' });
  const completion = (command: string, sessionId: string): LlmCompletion => ({
    text: authored(command),
    sessionId,
  });

  it('resumes its own session on a feedback round with a delta prompt (resume-capable provider)', async () => {
    const llm = new FakeLlm(
      [completion('npm test', 'sess-1'), completion('npm test -- --coverage', 'sess-2')],
      { supportsResume: true },
    );
    const compiler = new AgentCompiler({ llm });

    await compiler.compile(genConfig);
    await compiler.compile(genConfig, 'cover the CLI too');

    // First call: fresh full prompt, no resume — and it asks for a goaly-MINTED session so the
    // session it later resumes contains only the compiler's own turns (ambient-pin immunity).
    expect(llm.requests[0]?.resumeSessionId).toBeUndefined();
    expect(llm.requests[0]?.mintSession).toBe(true);
    expect(llm.requests[0]?.prompt).toContain('Goal:');
    // Second call: resumes session 1, sends ONLY the feedback delta (the goal lives in the session).
    expect(llm.requests[1]?.resumeSessionId).toBe('sess-1');
    expect(llm.requests[1]?.prompt).toContain('cover the CLI too');
    expect(llm.requests[1]?.prompt).not.toContain('Goal:');
    expect(llm.requests[1]?.prompt).toContain('COMPLETE verification JSON');
  });

  it('a chain of revise rounds follows the session forward (sess-1 → sess-2 → …)', async () => {
    const llm = new FakeLlm(
      [completion('npm test', 'sess-1'), completion('npm t2', 'sess-2'), completion('npm t3', 'sess-3')],
      { supportsResume: true },
    );
    const compiler = new AgentCompiler({ llm });

    await compiler.compile(genConfig);
    await compiler.compile(genConfig, 'round 1 feedback');
    await compiler.compile(genConfig, 'round 2 feedback');

    expect(llm.requests[1]?.resumeSessionId).toBe('sess-1');
    expect(llm.requests[2]?.resumeSessionId).toBe('sess-2');
  });

  it('a fresh compile (no feedback) starts a NEW session — continuity is per authoring lifecycle', async () => {
    const llm = new FakeLlm(
      [completion('npm test', 'sess-1'), completion('pytest -q', 'sess-9')],
      { supportsResume: true },
    );
    const compiler = new AgentCompiler({ llm });

    await compiler.compile(genConfig);
    await compiler.compile(genConfig); // e.g. the next phase of a phased run

    expect(llm.requests[1]?.resumeSessionId).toBeUndefined();
    expect(llm.requests[1]?.prompt).toContain('Goal:');
  });

  it('sends the full prompt on a feedback round when the provider cannot resume (default FakeLlm)', async () => {
    const llm = new FakeLlm([authored('npm test'), authored('npm test -- --coverage')]);
    const compiler = new AgentCompiler({ llm });

    await compiler.compile(genConfig);
    await compiler.compile(genConfig, 'cover the CLI too');

    // No session support ⇒ a delta prompt would reach an amnesiac model; the full prompt goes out.
    expect(llm.requests[1]?.resumeSessionId).toBeUndefined();
    expect(llm.requests[1]?.prompt).toContain('Goal:');
    expect(llm.requests[1]?.prompt).toContain('cover the CLI too');
  });

  it('falls back to a fresh full-prompt call when the resume attempt throws (never burns the round)', async () => {
    // A resume-capable provider that rejects the resumed call, then answers the fresh one.
    class ResumeRejecting implements LlmProvider {
      readonly name = 'resume-rejecting';
      readonly supportsResume = true;
      readonly requests: Array<{ prompt: string; resumeSessionId?: string }> = [];
      async complete(req: {
        prompt: string;
        resumeSessionId?: string;
      }): Promise<LlmCompletion> {
        this.requests.push({ prompt: req.prompt, ...(req.resumeSessionId !== undefined ? { resumeSessionId: req.resumeSessionId } : {}) });
        if (req.resumeSessionId !== undefined) throw new Error('stale session');
        return { text: authored('npm test'), sessionId: `sess-${this.requests.length}` };
      }
    }
    const llm = new ResumeRejecting();
    const compiler = new AgentCompiler({ llm });

    await compiler.compile(genConfig);
    const contract = await compiler.compile(genConfig, 'tighten the bar');

    expect(contract.rungs[0]).toEqual({ kind: 'deterministic', command: 'npm test' });
    // Attempted resume (call 2), then the fresh full-prompt fallback (call 3).
    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[1]?.resumeSessionId).toBe('sess-1');
    expect(llm.requests[2]?.resumeSessionId).toBeUndefined();
    expect(llm.requests[2]?.prompt).toContain('Goal:');
    expect(llm.requests[2]?.prompt).toContain('tighten the bar');
  });
});

describe('AgentCompiler — workspace facts + module-format lint (small-model steering)', () => {
  const genConfig = makeConfig({ verifier: { kind: 'generate' } });
  const esmFacts = {
    summary:
      'WORKSPACE FACTS (detected deterministically from files on disk — the goal need not be about ' +
      'code; ignore any fact irrelevant to it):\n- Node package: "type": "module".',
    nodeModuleSystem: 'esm' as const,
  };

  it('injects the detected facts into the authoring prompt (and only when provided)', async () => {
    const bare = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    await new AgentCompiler({ llm: bare }).compile(genConfig);
    expect(bare.requests[0]?.prompt).not.toContain('WORKSPACE FACTS');

    const withFacts = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    await new AgentCompiler({ llm: withFacts, facts: esmFacts }).compile(genConfig);
    expect(withFacts.requests[0]?.prompt).toContain('WORKSPACE FACTS');
    expect(withFacts.requests[0]?.prompt).toContain('"type": "module"');
  });

  it('refuses to freeze an authored .js file that cannot load under the detected module system', async () => {
    const llm = new FakeLlm([
      JSON.stringify({
        command: 'node verify.js',
        rubric: '',
        files: [{ path: 'verify.js', content: "const fs = require('fs');\nprocess.exit(0);\n" }],
      }),
    ]);
    const compiler = new AgentCompiler({ llm, facts: esmFacts });

    await expect(compiler.compile(genConfig)).rejects.toThrow(/cannot load/);
  });

  it('the same authored file freezes fine when no module system was detected (non-code workspace)', async () => {
    const llm = new FakeLlm([
      JSON.stringify({
        command: 'node verify.js',
        rubric: '',
        files: [{ path: 'verify.js', content: "const fs = require('fs');\nprocess.exit(0);\n" }],
      }),
    ]);
    const writes: string[] = [];
    const compiler = new AgentCompiler({
      llm,
      writeFile: async (rel) => void writes.push(rel),
    });

    const contract = await compiler.compile(genConfig);

    expect(contract.generatedFiles.map((f) => f.path)).toEqual(['verify.js']);
    expect(writes).toEqual(['verify.js']);
  });
});
