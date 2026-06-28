import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import type { OrchestratorEvent, BudgetSnapshot } from '../domain/events';
import { makeFakeContract, makeConfig, passVerdict, failVerdict, dh } from '../testing/fakes';

const contract = makeFakeContract();
const budget: BudgetSnapshot = { exceeded: false };

function agentRan(prev: string, post: string): OrchestratorEvent {
  const [p, q] = dh(prev, post);
  return {
    tag: 'AGENT_RAN',
    run: { output: '', sessionId: 'sess-1' as never, status: 'completed' },
    prevDiffHash: p!,
    diffHash: q!,
    budget,
  };
}

/** A crashed agent run (harness exited abnormally), carrying the harness's own error output. */
function agentCrashed(prev: string, post: string, output: string): OrchestratorEvent {
  const [p, q] = dh(prev, post);
  return {
    tag: 'AGENT_RAN',
    run: { output, sessionId: 'sess-1' as never, status: 'crashed' },
    prevDiffHash: p!,
    diffHash: q!,
    budget,
  };
}

describe('step() transitions', () => {
  it('initial() seeds COMPILING + a COMPILE_VERIFIER command', () => {
    const [state, commands] = initial(makeConfig());
    expect(state.tag).toBe('COMPILING');
    expect(commands).toEqual([{ tag: 'COMPILE_VERIFIER', config: makeConfig() }]);
  });

  it('CONTRACT_COMPILED → AWAIT_SEAL + REQUEST_SEAL', () => {
    const [state] = initial(makeConfig());
    const [next, cmds] = step(state, { tag: 'CONTRACT_COMPILED', contract });
    expect(next.tag).toBe('AWAIT_SEAL');
    expect(cmds[0]).toEqual({ tag: 'REQUEST_SEAL', contract });
  });

  it('COMPILE_FAILED → terminal FAILED when retries are disabled (maxCompileRetries: 0)', () => {
    const [state] = initial(makeConfig({ maxCompileRetries: 0 }));
    const [next] = step(state, { tag: 'COMPILE_FAILED', reason: 'nope' });
    expect(next).toMatchObject({ tag: 'FAILED', reason: 'nope', contractHash: undefined });
  });

  it('COMPILE_FAILED re-authors with the error as feedback, bounded by maxCompileRetries (issue #51)', () => {
    const config = makeConfig({ maxCompileRetries: 2 });
    // Round 0: first failure retries (compileRound 0 → 1) carrying the error as feedback.
    const [s1, c1] = step(initial(config)[0], { tag: 'COMPILE_FAILED', reason: 'wrote to /tmp' });
    expect(s1).toMatchObject({ tag: 'COMPILING', compileRound: 1 });
    expect(c1[0]).toMatchObject({ tag: 'COMPILE_VERIFIER', config });
    if (c1[0]?.tag === 'COMPILE_VERIFIER') expect(c1[0].feedback).toContain('wrote to /tmp');

    // Round 1: second failure retries again (compileRound 1 → 2).
    const [s2, c2] = step(s1, { tag: 'COMPILE_FAILED', reason: 'still bad' });
    expect(s2).toMatchObject({ tag: 'COMPILING', compileRound: 2 });
    if (c2[0]?.tag === 'COMPILE_VERIFIER') expect(c2[0].feedback).toContain('still bad');

    // Round 2: budget exhausted (compileRound 2 == max) → terminal FAILED, never a skipped check.
    const [s3] = step(s2, { tag: 'COMPILE_FAILED', reason: 'final' });
    expect(s3).toMatchObject({ tag: 'FAILED', reason: 'final', contractHash: undefined });
  });

  it('a retried compile that succeeds proceeds to Seal (issue #51)', () => {
    const config = makeConfig({ maxCompileRetries: 2 });
    const [s1] = step(initial(config)[0], { tag: 'COMPILE_FAILED', reason: 'bad path' });
    const [s2, cmds] = step(s1, { tag: 'CONTRACT_COMPILED', contract });
    expect(s2.tag).toBe('AWAIT_SEAL');
    expect(cmds[0]).toEqual({ tag: 'REQUEST_SEAL', contract });
  });

  it('Seal revise resets the compile-retry counter (issue #51)', () => {
    const config = makeConfig({ maxCompileRetries: 2 });
    // Burn one compile retry, then succeed and revise — the next authoring starts at compileRound 0.
    const [s1] = step(initial(config)[0], { tag: 'COMPILE_FAILED', reason: 'oops' });
    const [s2] = step(s1, { tag: 'CONTRACT_COMPILED', contract });
    const [s3] = step(s2, { tag: 'SEAL_DECIDED', decision: { kind: 'revise', feedback: 'redo' } });
    expect(s3).toMatchObject({ tag: 'COMPILING', reviseRound: 1, compileRound: 0 });
  });

  it('Seal approval starts the first iteration with an initial prompt', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
    expect(s2.tag).toBe('RUNNING_AGENT');
    expect(cmds[0]).toMatchObject({ tag: 'RUN_AGENT', sessionId: undefined });
    if (cmds[0]?.tag === 'RUN_AGENT') expect(cmds[0].prompt).toContain(contract.goal);
  });

  it('seeds the FIRST RUN_AGENT session from config.seedSessionId (Capability C inheritance)', () => {
    const config = makeConfig({ seedSessionId: 'prior-session-xyz' as never });
    const [s0] = initial(config);
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
    expect(cmds[0]).toMatchObject({ tag: 'RUN_AGENT', sessionId: 'prior-session-xyz' });
  });

  describe('prepare phase (Fix #1 setup + Fix #2 pre-flight)', () => {
    const setupContract = makeFakeContract({ setup: 'npm ci' });

    it('Seal approval with a setup command → PREPARING + PREPARE_WORKSPACE (not the loop yet)', () => {
      const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract: setupContract });
      const [s2, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(s2.tag).toBe('PREPARING');
      // The command carries the missing-tool policy so the Driver knows whether to install or abort.
      expect(cmds[0]).toMatchObject({ tag: 'PREPARE_WORKSPACE', installMissingTools: true });
    });

    it('a requiredTools manifest alone triggers PREPARING (so the tool probe runs)', () => {
      const toolContract = makeFakeContract({ requiredTools: ['cargo'] });
      const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract: toolContract });
      const [s2] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(s2.tag).toBe('PREPARING');
    });

    it('--install-missing-tools false rides on the PREPARE_WORKSPACE command', () => {
      const cfg = makeConfig({ installMissingTools: false });
      const [s1] = step(initial(cfg)[0], { tag: 'CONTRACT_COMPILED', contract: setupContract });
      const [, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(cmds[0]).toMatchObject({ tag: 'PREPARE_WORKSPACE', installMissingTools: false });
    });

    it('an authored setup (no --setup-cmd) marks setupAuthored:true on PREPARE_WORKSPACE (Fix A)', () => {
      // makeConfig has no setupCmd ⇒ the compiler authored the setup ⇒ best-effort.
      const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract: setupContract });
      const [, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(cmds[0]).toMatchObject({ tag: 'PREPARE_WORKSPACE', setupAuthored: true });
    });

    it('a user --setup-cmd marks setupAuthored:false on PREPARE_WORKSPACE (stays fatal)', () => {
      const cfg = makeConfig({ setupCmd: 'npm ci' });
      const [s1] = step(initial(cfg)[0], { tag: 'CONTRACT_COMPILED', contract: setupContract });
      const [, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(cmds[0]).toMatchObject({ tag: 'PREPARE_WORKSPACE', setupAuthored: false });
    });

    it('a contract with no setup (generatedFiles only) marks setupAuthored:false', () => {
      const filesContract = makeFakeContract({
        generatedFiles: [{ path: 'verify/x.test.ts', sha256: 'a'.repeat(64) }],
      });
      const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract: filesContract });
      const [, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(cmds[0]).toMatchObject({ tag: 'PREPARE_WORKSPACE', setupAuthored: false });
    });

    it('Seal approval with authored generatedFiles also pre-flights (PREPARING)', () => {
      const withFiles = makeFakeContract({
        generatedFiles: [{ path: 'verify/x.test.ts', sha256: 'a'.repeat(64) }],
      });
      const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract: withFiles });
      const [s2] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(s2.tag).toBe('PREPARING');
    });

    it('a plain --verify-cmd contract (no setup, no generated files) skips prepare → straight to the loop', () => {
      const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract });
      const [s2] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(s2.tag).toBe('RUNNING_AGENT');
    });

    function preparing(): ReturnType<typeof step>[0] {
      const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract: setupContract });
      return step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } })[0];
    }

    it('proceed → starts iteration 1 with the initial prompt', () => {
      const [s, cmds] = step(preparing(), {
        tag: 'WORKSPACE_PREPARED',
        prepared: { status: 'proceed' },
        setupRan: true,
      });
      expect(s.tag).toBe('RUNNING_AGENT');
      expect(cmds[0]).toMatchObject({ tag: 'RUN_AGENT', sessionId: undefined });
    });

    it('proceed carrying installTools → first prompt includes the bootstrap install instruction', () => {
      const [s, cmds] = step(preparing(), {
        tag: 'WORKSPACE_PREPARED',
        prepared: { status: 'proceed', installTools: ['cargo', 'rustup'] },
        setupRan: false,
      });
      expect(s.tag).toBe('RUNNING_AGENT');
      if (cmds[0]?.tag === 'RUN_AGENT') {
        expect(cmds[0].prompt).toContain('Bootstrap required first');
        expect(cmds[0].prompt).toContain('cargo, rustup');
        expect(cmds[0].prompt).toContain('npm ci'); // the skipped setup is handed to the agent
      }
    });

    it('proceed carrying a setupHint → first prompt includes the setup note (Fix A)', () => {
      const [s, cmds] = step(preparing(), {
        tag: 'WORKSPACE_PREPARED',
        prepared: {
          status: 'proceed',
          setupHint: 'A one-time setup command was attempted: `go mod download`. Create scaffolding…',
        },
        setupRan: true,
      });
      expect(s.tag).toBe('RUNNING_AGENT');
      if (cmds[0]?.tag === 'RUN_AGENT') {
        expect(cmds[0].prompt).toContain('Setup note');
        expect(cmds[0].prompt).toContain('go mod download');
      }
    });

    it('tools-missing → FAILED (TOOLS_MISSING) before any worker turn', () => {
      const [s] = step(preparing(), {
        tag: 'WORKSPACE_PREPARED',
        prepared: { status: 'tools-missing', detail: 'the verification requires cargo, which is not installed' },
        setupRan: false,
      });
      expect(s).toMatchObject({ tag: 'FAILED', iterations: 0 });
      if (s.tag === 'FAILED') {
        expect(s.reason).toContain('TOOLS_MISSING');
        expect(s.reason).toContain('cargo');
      }
    });

    it('setup-failed → FAILED (SETUP_FAILED) before any worker turn', () => {
      const [s] = step(preparing(), {
        tag: 'WORKSPACE_PREPARED',
        prepared: { status: 'setup-failed', detail: 'npm ci exited 1' },
        setupRan: true,
      });
      expect(s).toMatchObject({ tag: 'FAILED', iterations: 0 });
      if (s.tag === 'FAILED') {
        expect(s.reason).toContain('SETUP_FAILED');
        expect(s.reason).toContain('npm ci exited 1');
      }
    });

    it('contract-unsound → FAILED (CONTRACT_UNSOUND) before any worker turn', () => {
      const [s] = step(preparing(), {
        tag: 'WORKSPACE_PREPARED',
        prepared: { status: 'contract-unsound', detail: "TS2339 in verify/x.test.ts" },
        setupRan: true,
      });
      expect(s).toMatchObject({ tag: 'FAILED', iterations: 0 });
      if (s.tag === 'FAILED') expect(s.reason).toContain('CONTRACT_UNSOUND');
    });
  });

  it('Seal rejection → ABORTED before the loop starts', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2] = step(s1, {
      tag: 'SEAL_DECIDED',
      decision: { kind: 'reject', reason: 'bad bar' },
    });
    expect(s2).toMatchObject({ tag: 'ABORTED', reason: 'bad bar' });
  });

  it('Seal revise → back to COMPILING with a feedback-carrying COMPILE_VERIFIER', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2, cmds] = step(s1, {
      tag: 'SEAL_DECIDED',
      decision: { kind: 'revise', feedback: 'make it stricter' },
    });
    expect(s2).toMatchObject({ tag: 'COMPILING', reviseRound: 1 });
    expect(cmds[0]).toEqual({
      tag: 'COMPILE_VERIFIER',
      config: makeConfig(),
      feedback: 'make it stricter',
    });
  });

  it('revise carries reviseRound forward and re-presents at Seal', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2] = step(s1, {
      tag: 'SEAL_DECIDED',
      decision: { kind: 'revise', feedback: 'again' },
    });
    // The re-compile lands back at AWAIT_SEAL with reviseRound preserved.
    const [s3] = step(s2, { tag: 'CONTRACT_COMPILED', contract });
    expect(s3).toMatchObject({ tag: 'AWAIT_SEAL', reviseRound: 1 });
  });

  it('revise past maxSealRevisions → ABORTED', () => {
    const config = makeConfig({ maxSealRevisions: 1 });
    let state = step(initial(config)[0], { tag: 'CONTRACT_COMPILED', contract })[0];
    // First revise is allowed (round 0 → 1).
    state = step(state, { tag: 'SEAL_DECIDED', decision: { kind: 'revise', feedback: 'a' } })[0];
    state = step(state, { tag: 'CONTRACT_COMPILED', contract })[0];
    // Second revise exceeds the cap of 1 → abort.
    const [aborted] = step(state, {
      tag: 'SEAL_DECIDED',
      decision: { kind: 'revise', feedback: 'b' },
    });
    expect(aborted).toMatchObject({ tag: 'ABORTED' });
    if (aborted.tag === 'ABORTED') expect(aborted.reason).toContain('revision cap');
  });

  it('maxSealRevisions: 0 aborts on the first revise', () => {
    const config = makeConfig({ maxSealRevisions: 0 });
    const state = step(initial(config)[0], { tag: 'CONTRACT_COMPILED', contract })[0];
    const [aborted] = step(state, {
      tag: 'SEAL_DECIDED',
      decision: { kind: 'revise', feedback: 'x' },
    });
    expect(aborted).toMatchObject({ tag: 'ABORTED' });
  });

  it('AGENT_RAN → VERIFYING + RUN_VERIFIER, threading the session id', () => {
    const ra = runningAgent();
    const [next, cmds] = step(ra, agentRan('0000000', '0000001'));
    expect(next.tag).toBe('VERIFYING');
    expect(cmds[0]).toEqual({ tag: 'RUN_VERIFIER', contract });
  });

  it('a crashed AGENT_RAN threads the run status + output into the loop ctx (for crash-streak detection)', () => {
    const [next] = step(runningAgent(), agentCrashed('0000000', '0000001', 'claude: command not found'));
    expect(next.tag).toBe('VERIFYING');
    if (next.tag === 'VERIFYING') {
      expect(next.ctx.runStatusHistory).toEqual(['crashed']);
      expect(next.ctx.lastRunStatus).toBe('crashed');
      expect(next.ctx.lastRunOutput).toBe('claude: command not found');
    }
  });

  it('two consecutive harness crashes → ABORTED (STUCK_HARNESS_CRASH), not the downstream verifier red', () => {
    // First crash: a red ladder CONTINUEs (one crash may be transient). The crash output is surfaced.
    const v1 = step(runningAgent(), agentCrashed('0000000', '0000001', 'segfault'))[0];
    const [cont] = step(v1, { tag: 'VERIFIED', verdict: failVerdict('ImportError: no module') });
    expect(cont.tag).toBe('RUNNING_AGENT');

    // Second consecutive crash: the streak (2) trips the typed harness-crash abort.
    const v2 = step(cont, agentCrashed('0000001', '0000002', 'segfault'))[0];
    const [aborted] = step(v2, { tag: 'VERIFIED', verdict: failVerdict('ImportError: no module') });
    expect(aborted.tag).toBe('ABORTED');
    if (aborted.tag === 'ABORTED') {
      expect(aborted.reason).toContain('STUCK_HARNESS_CRASH');
      expect(aborted.reason).toContain('segfault');
      expect(aborted.reason).not.toContain('STUCK_REPEATED_FAILURE');
    }
  });

  it('VERIFIED pass → AWAIT_SIGNOFF + REQUEST_SIGNOFF with the frozen rubric', () => {
    const verifying = step(runningAgent(), agentRan('0000000', '0000001'))[0];
    const [next, cmds] = step(verifying, { tag: 'VERIFIED', verdict: passVerdict() });
    expect(next.tag).toBe('AWAIT_SIGNOFF');
    expect(cmds[0]).toMatchObject({ tag: 'REQUEST_SIGNOFF', goal: contract.goal });
  });

  it('VERIFIED fail → CONTINUE: back to RUNNING_AGENT with feedback in the prompt', () => {
    const verifying = step(runningAgent(), agentRan('0000000', '0000001'))[0];
    const [next, cmds] = step(verifying, { tag: 'VERIFIED', verdict: failVerdict('build broke') });
    expect(next.tag).toBe('RUNNING_AGENT');
    if (cmds[0]?.tag === 'RUN_AGENT') expect(cmds[0].prompt).toContain('build broke');
  });

  it('throws on an invalid (state, event) pair', () => {
    const [s0] = initial(makeConfig());
    expect(() => step(s0, { tag: 'VERIFIED', verdict: passVerdict() })).toThrow(
      /invalid transition/,
    );
  });

  it('throws when stepped on a terminal state', () => {
    const terminal = { tag: 'DONE', iterations: 1, contractHash: contract.contractHash } as const;
    expect(() => step(terminal, { tag: 'VERIFIED', verdict: passVerdict() })).toThrow(/terminal/);
  });
});

/** Drive the machine to a RUNNING_AGENT state for transition tests. */
function runningAgent() {
  const [s0] = initial(makeConfig());
  const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
  const [s2] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
  return s2;
}
