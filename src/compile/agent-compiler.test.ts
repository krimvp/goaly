import { describe, it, expect } from 'vitest';
import { ContractHash } from '../domain/ids';
import { FakeLlm } from '../llm/provider';
import { makeConfig } from '../testing/fakes';
import { AgentCompiler, isVacuousCommand, referencesOutOfRepoPath } from './agent-compiler';

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

describe('AgentCompiler — rubric guardrails (issue #55)', () => {
  it('carries the runnable-bar guardrails in the authoring system prompt', async () => {
    const llm = new FakeLlm([JSON.stringify({ command: 'npm test', rubric: '' })]);
    const compiler = new AgentCompiler({ llm });
    await compiler.compile(makeConfig({ verifier: { kind: 'generate' } }));

    const system = llm.requests[0]?.system ?? '';
    expect(system).toContain('EXISTING tooling');
    expect(system).toContain('/tmp');
    expect(system).toContain('RELATIVE path');
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
