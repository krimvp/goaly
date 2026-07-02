import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { preflightRun } from './preflight';

const gitOk = { isGitWorkTree: async () => true };

describe('preflightRun', () => {
  it('flags a non-git workspace with actionable guidance', async () => {
    const problem = await preflightRun(
      { harness: 'claude', llmProvider: 'claude', workspace: '/some/dir' },
      { isGitWorkTree: async () => false, which: () => true },
    );
    expect(problem).toContain('not a git repository');
    expect(problem).toContain('git init');
  });

  it('flags a missing harness CLI with install guidance, before any spend', async () => {
    const problem = await preflightRun(
      { harness: 'claude', llmProvider: 'openai', workspace: '/w' },
      { ...gitOk, which: () => false },
    );
    expect(problem).toContain("'claude' CLI");
    expect(problem).toContain('--harness claude');
    expect(problem).toContain('not found on PATH');
  });

  it('flags a missing LLM-provider CLI separately from the harness', async () => {
    const problem = await preflightRun(
      { harness: 'goaly-code', llmProvider: 'codex', workspace: '/w' },
      { ...gitOk, which: (bin) => bin !== 'codex' },
    );
    expect(problem).toContain("'codex' CLI");
    expect(problem).toContain('--llm-provider codex');
  });

  it('passes when everything is present', async () => {
    const problem = await preflightRun(
      { harness: 'claude', llmProvider: 'claude', workspace: '/w' },
      { ...gitOk, which: () => true },
    );
    expect(problem).toBeNull();
  });

  it('skips the CLI probes for the fake harness (zero-external-tool test/demo mode)', async () => {
    const problem = await preflightRun(
      { harness: 'fake', llmProvider: 'claude', workspace: '/w' },
      { ...gitOk, which: () => false },
    );
    expect(problem).toBeNull();
  });

  it('skips CLI probes for goaly-code + openai (endpoint-backed, no CLI needed)', async () => {
    const problem = await preflightRun(
      { harness: 'goaly-code', llmProvider: 'openai', workspace: '/w' },
      { ...gitOk, which: () => false },
    );
    expect(problem).toBeNull();
  });

  it('real git probe: true inside a repo, false in a bare temp dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goaly-preflight-'));
    try {
      const before = await preflightRun(
        { harness: 'fake', llmProvider: 'claude', workspace: dir },
      );
      expect(before).toContain('not a git repository');

      const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      const after = await preflightRun(
        { harness: 'fake', llmProvider: 'claude', workspace: dir },
      );
      expect(after).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
