import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeDeps } from './compose';
import { drive } from '../driver/driver';
import { makeConfig } from '../testing/fakes';
import { asRunId, coerceSessionId, type SessionId } from '../domain/ids';
import type { HarnessAdapter } from '../harness/adapter';
import type { LlmProvider } from '../llm/provider';
import { runProcess } from '../util/spawn';

/**
 * The parallel-wave pipeline END TO END on REAL git — real worktrees, real 3-way merges, real
 * promotion — with zero LLM tokens and zero agent CLIs: the LLM is routed by prompt content (each
 * step's schema marker) so the CONCURRENT children can't race a scripted queue, and the harness is
 * a scripted writer that creates whatever file its sub-goal names, inside its own worktree.
 */

const routedLlm: LlmProvider = {
  name: 'routed-fake-llm',
  async complete(req) {
    // The schema/marker may live in `system` (the compiler's session-style calls) or the prompt.
    const p = `${req.system ?? ''}\n${req.prompt}`;
    // The usage-gate shape classification (compile phase).
    if (p.includes('"buildAndUse"')) {
      return { text: '{"buildAndUse":false,"targetArtifact":null,"reason":"n/a"}' };
    }
    // The Sign-off approver (child sign-offs + the acceptance sign-off).
    if (p.includes('{"veto"')) return { text: '{"veto": false}' };
    // The per-child authoring compiler: a deterministic bar per sub-goal, no rubric (no judge rung).
    if (p.includes('"command": string')) {
      if (p.includes('a.txt')) return { text: '{"command":"test -f a.txt","rubric":""}' };
      if (p.includes('b.txt')) return { text: '{"command":"test -f b.txt","rubric":""}' };
      return { text: '{"command":"true","rubric":""}' };
    }
    throw new Error(`unrouted LLM prompt: ${p.slice(0, 160)}`);
  },
};

/** A worker that "achieves" its sub-goal by writing the file the prompt names — in ITS OWN root. */
function scriptedWriter(root: string): HarnessAdapter {
  return {
    name: 'scripted-wave-writer',
    async run(prompt: string, sessionId?: SessionId) {
      const id = sessionId ?? coerceSessionId('scripted', 'scripted');
      if (prompt.includes('a.txt')) await writeFile(path.join(root, 'a.txt'), 'alpha\n');
      if (prompt.includes('b.txt')) await writeFile(path.join(root, 'b.txt'), 'beta\n');
      return { output: 'did the work', sessionId: id, status: 'completed' as const };
    },
  };
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'goaly-wave-e2e-'));
  await runProcess('git', ['-C', dir, 'init', '-q']);
  await runProcess('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await runProcess('git', ['-C', dir, 'config', 'user.name', 'tester']);
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  await runProcess('git', ['-C', dir, 'add', '-A']);
  await runProcess('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

describe('parallel waves END TO END (compose + drive, real git, routed fake LLM)', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('runs a grouped plan as one wave: children fork, merge cleanly, re-verify, acceptance gates DONE', async () => {
    dir = await initRepo();
    // Two INDEPENDENT sub-goals sharing wave group 1 — the whole plan is one wave + acceptance.
    await writeFile(
      path.join(dir, 'plan.json'),
      JSON.stringify({
        phases: [
          { goal: 'create a file a.txt containing alpha', group: 1 },
          { goal: 'create a file b.txt containing beta', group: 1 },
        ],
      }),
    );
    const config = makeConfig({
      goal: 'produce both fixture files',
      // The ORIGINAL verifier becomes the cumulative acceptance bar on the whole merged tree.
      verifier: { kind: 'existing', ref: 'test -f a.txt && test -f b.txt' },
      autonomous: true,
      phased: true,
      parallelPhases: true,
    });
    const runId = asRunId('run-wave-e2e');
    const deps = composeDeps(config, {
      harness: 'fake',
      harnessFactory: scriptedWriter,
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      llm: routedLlm,
      planFile: path.join(dir, 'plan.json'),
    });

    const outcome = await drive(deps, config, runId);

    // The whole run reaches DONE through the acceptance contract's two keys.
    expect(outcome.status).toBe('DONE');
    // BOTH children's work landed in the canonical tree via the 3-way merge (disjoint files).
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(await readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('beta\n');

    // The parent log carries ONE WAVE_RAN with both phases merged — and the reducer never saw the
    // children's iterations (each child kept its own write-ahead log in its worktree).
    const stored = await deps.runlog.read();
    const wave = stored?.entries.find((e) => e.event.tag === 'WAVE_RAN');
    expect(wave?.event.tag).toBe('WAVE_RAN');
    if (wave?.event.tag === 'WAVE_RAN') {
      expect(wave.event.outcomes.map((o) => o.kind)).toEqual(['merged', 'merged']);
    }
    // No stray worktrees left behind.
    const wt = await runProcess('git', ['-C', dir, 'worktree', 'list']);
    expect(wt.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('a conflicting wave member downgrades to the classic sequential phase and the run still finishes', async () => {
    dir = await initRepo();
    // BOTH sub-goals write the SAME file with different content — the second merge must conflict,
    // downgrade to a sequential re-run on the merged tree, and the run must still reach DONE.
    await writeFile(
      path.join(dir, 'plan.json'),
      JSON.stringify({
        phases: [
          { goal: 'create clash.txt saying alpha', group: 1 },
          { goal: 'make clash.txt say beta instead', group: 1 },
        ],
      }),
    );
    const conflictLlm: LlmProvider = {
      name: 'routed-fake-llm',
      async complete(req) {
        const p = `${req.system ?? ''}\n${req.prompt}`;
        if (p.includes('"buildAndUse"')) {
          return { text: '{"buildAndUse":false,"targetArtifact":null,"reason":"n/a"}' };
        }
        if (p.includes('{"veto"')) return { text: '{"veto": false}' };
        if (p.includes('"command": string')) {
          if (p.includes('beta')) return { text: '{"command":"grep -q beta clash.txt","rubric":""}' };
          return { text: '{"command":"grep -q alpha clash.txt","rubric":""}' };
        }
        throw new Error(`unrouted LLM prompt: ${p.slice(0, 160)}`);
      },
    };
    const conflictWriter = (root: string): HarnessAdapter => ({
      name: 'scripted-conflict-writer',
      async run(prompt: string, sessionId?: SessionId) {
        const id = sessionId ?? coerceSessionId('scripted', 'scripted');
        // Each child rewrites the SAME file; the sequential fallback then runs on the merged tree.
        if (prompt.includes('beta')) await writeFile(path.join(root, 'clash.txt'), 'beta\n');
        else await writeFile(path.join(root, 'clash.txt'), 'alpha\n');
        return { output: 'did the work', sessionId: id, status: 'completed' as const };
      },
    });
    const config = makeConfig({
      goal: 'end with clash.txt saying beta',
      verifier: { kind: 'existing', ref: 'grep -q beta clash.txt' },
      autonomous: true,
      phased: true,
      parallelPhases: true,
    });
    const runId = asRunId('run-wave-conflict');
    const deps = composeDeps(config, {
      harness: 'fake',
      harnessFactory: conflictWriter,
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      llm: conflictLlm,
      planFile: path.join(dir, 'plan.json'),
    });

    const outcome = await drive(deps, config, runId);

    expect(outcome.status).toBe('DONE');
    expect(await readFile(path.join(dir, 'clash.txt'), 'utf8')).toBe('beta\n');

    const stored = await deps.runlog.read();
    const wave = stored?.entries.find((e) => e.event.tag === 'WAVE_RAN');
    expect(wave?.event.tag).toBe('WAVE_RAN');
    if (wave?.event.tag === 'WAVE_RAN') {
      const kinds = wave.event.outcomes.map((o) => o.kind).sort();
      expect(kinds).toEqual(['merged', 'unmerged']); // one landed, one downgraded fail-closed
    }
    // The downgraded phase re-ran through the CLASSIC sequential path: its own frozen contract.
    const contracts = stored?.entries.filter((e) => e.event.tag === 'CONTRACT_COMPILED') ?? [];
    expect(contracts.length).toBeGreaterThanOrEqual(2); // the fallback phase + acceptance
  });
});
