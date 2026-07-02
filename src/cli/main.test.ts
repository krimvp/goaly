import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatOutcome, main, makeInterruptController, nextStepHint } from './main';
import { formatUsage } from './usage-format';
import { STATE_DIR } from './compose';
import { FileRunLog } from '../runlog/file-runlog';
import { makeConfig, makeFakeContract } from '../testing/fakes';
import type { RunOutcome } from '../domain/events';
import type { UsageReport } from '../domain/usage';
import { RunId, ContractHash, DiffHash, SessionId } from '../domain/ids';
import type { CostView } from './cost';

const usage = (overrides: Partial<UsageReport> = {}): UsageReport => ({
  harness: { tokens: 12_000, calls: 1, unknownCalls: 0 },
  compiler: { tokens: 800, calls: 1, unknownCalls: 0 },
  verifier: { tokens: 1_200, calls: 3, unknownCalls: 0 },
  approver: { tokens: 400, calls: 1, unknownCalls: 0 },
  llm: { tokens: 2_400, calls: 5, unknownCalls: 0 },
  total: { tokens: 14_400, calls: 6, unknownCalls: 0 },
  budget: { tokens: 20_000, spent: 14_400, exceeded: false },
  ...overrides,
});

const outcome = (overrides: Partial<RunOutcome> = {}): RunOutcome => ({
  status: 'DONE',
  iterations: 3,
  contractHash: ContractHash.parse('a'.repeat(64)),
  runId: RunId.parse('run-x'),
  usage: usage(),
  ...overrides,
});

describe('formatUsage', () => {
  it('renders the per-layer token breakdown with thousands separators', () => {
    const lines = formatUsage(usage());
    const text = lines.join('\n');
    expect(text).toContain('harness');
    expect(text).toContain('12,000 tokens');
    expect(text).toContain('llm subtotal');
    expect(text).toContain('2,400 tokens');
    expect(text).toContain('total');
    expect(text).toContain('14,400 tokens');
  });

  it('surfaces the per-category split (incl. cache) under the total when reported', () => {
    const u = usage({
      total: {
        tokens: 14_400,
        calls: 6,
        unknownCalls: 0,
        breakdown: { input: 1_400, output: 1_000, cacheRead: 9_000, cacheWrite: 3_000 },
      },
    });
    const text = formatUsage(u).join('\n');
    expect(text).toContain('by category');
    expect(text).toContain('cache-read 9,000');
    expect(text).toContain('cache-write 3,000');
  });

  it('renders budget consumed vs the cap with a percentage', () => {
    const text = formatUsage(usage()).join('\n');
    expect(text).toContain('budget:');
    expect(text).toContain('14,400 / 20,000 tokens (72%)');
  });

  it('flags an exceeded budget', () => {
    const u = usage({ budget: { tokens: 10_000, spent: 12_000, exceeded: true } });
    expect(formatUsage(u).join('\n')).toContain('budget exceeded');
  });

  it('omits the budget line when no cap is configured', () => {
    const u = usage({ budget: { spent: 14_400, exceeded: false } });
    expect(formatUsage(u).join('\n')).not.toContain('budget:');
  });

  it('surfaces missing token data as "unknown" rather than zero', () => {
    const u = usage({ harness: { tokens: 0, calls: 1, unknownCalls: 1 } });
    expect(formatUsage(u).join('\n')).toContain('unknown (1 call(s) reported no usage)');
  });

  it('marks the estimated portion of a layer (issue #24)', () => {
    const u = usage({ harness: { tokens: 3_000, calls: 1, unknownCalls: 0, estimatedTokens: 3_000 } });
    const text = formatUsage(u).join('\n');
    expect(text).toContain('3,000 tokens (3,000 estimated)');
  });

  it('overlays an approximate USD cost per layer when a cost view is given', () => {
    const cost: CostView = {
      harness: 0.12,
      compiler: 0.01,
      verifier: 0.02,
      approver: 0.01,
      llm: 0.04,
      total: 0.16,
      partial: false,
    };
    const text = formatUsage(usage(), cost).join('\n');
    expect(text).toContain('≈ $0.12');
    expect(text).toContain('≈ $0.16');
  });

  it('marks the total approximate when some models were unpriced', () => {
    const cost: CostView = { harness: 0.12, llm: 0, total: 0.12, partial: true };
    const text = formatUsage(usage(), cost).join('\n');
    expect(text).toContain('some models unpriced');
  });
});

describe('formatOutcome', () => {
  it('appends the spend block when the outcome carries usage', () => {
    const text = formatOutcome(outcome());
    expect(text).toContain('status:      DONE');
    expect(text).toContain('spend:');
    expect(text).toContain('12,000 tokens');
  });

  it('omits the spend block when usage is absent', () => {
    const text = formatOutcome(outcome({ usage: undefined }));
    expect(text).not.toContain('spend:');
  });
});

describe('nextStepHint — always-on next-step guidance for terminal outcomes', () => {
  const aborted = (reason: string): RunOutcome =>
    outcome({ status: 'ABORTED', reason, usage: undefined });

  it('maps the typed stuck/prepare reasons to actionable hints', () => {
    expect(nextStepHint(aborted('STUCK_HARNESS_CRASH: claude: command not found'))).toContain(
      'run it once by hand',
    );
    expect(nextStepHint(aborted('CONTRACT_UNEVALUABLE: pytest could not be started'))).toContain(
      'could not RUN',
    );
    expect(nextStepHint(aborted('budget exceeded'))).toContain('--budget-tokens');
    expect(
      nextStepHint(outcome({ status: 'FAILED', reason: 'reached maxIterations (12) without satisfying the contract', usage: undefined })),
    ).toContain('--max-iterations');
    // The stuck hints name the exact extension flag — a plain resume would replay to the same abort.
    expect(nextStepHint(aborted('no-diff: working tree unchanged after an iteration'))).toContain(
      '--stuck-no-diff false',
    );
    expect(nextStepHint(aborted('STUCK_HARNESS_CRASH: boom'))).toContain('--stuck-crash-threshold');
  });

  it('stays quiet on DONE, unknown reasons, and user interrupts (already self-describing)', () => {
    expect(nextStepHint(outcome())).toBeUndefined();
    expect(nextStepHint(aborted('some novel reason'))).toBeUndefined();
    expect(nextStepHint(aborted('interrupted by user — resume this run with: --resume run-x'))).toBeUndefined();
  });

  it('formatOutcome renders the hint as a next: line', () => {
    const text = formatOutcome(aborted('budget exceeded'));
    expect(text).toContain('next:');
    expect(text).toContain('--budget-tokens');
  });
});

describe('makeInterruptController', () => {
  it('first signal warns with the resume command and flips interrupted; second force-exits', () => {
    const warned: string[] = [];
    let forced = 0;
    const c = makeInterruptController('run-abc', (s) => warned.push(s), () => {
      forced += 1;
    });

    expect(c.interrupted()).toBe(false);
    c.onSignal();
    expect(c.interrupted()).toBe(true);
    expect(warned.join('')).toContain('--resume run-abc');
    expect(warned.join('')).toContain('finishing the current step');
    expect(forced).toBe(0);

    c.onSignal();
    expect(forced).toBe(1);
  });
});

describe('main() — --baseline validation (issue #47)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-main-baseline-'));
    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    await writeFile(join(root, 'f.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Capture process.stderr around a call so the usage error is asserted without leaking to the run. */
  async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await fn();
      return { code, err: writes.join('') };
    } finally {
      process.stderr.write = orig;
    }
  }

  it('refuses to start (exit 2) on an unresolvable --baseline, before any run', async () => {
    const { code, err } = await captureStderr(() =>
      main(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'fake', '--autonomous',
        '--workspace', root, '--baseline', 'no-such-ref']),
    );
    expect(code).toBe(2);
    expect(err).toContain('--baseline no-such-ref');
  });
});

describe('main() — resume extension end-to-end (operator control, ADR 0012)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-main-extend-'));
    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test User');
    await writeFile(join(root, 'f.txt'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function captureAll(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const writes: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const capture = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      return { code: await fn(), out: writes.join('') };
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  }

  it('revives a stuck-aborted run via --resume with a stuck override + note (zero LLM)', async () => {
    // Run 1: the fake harness edits nothing and the deterministic bar is red → no-diff ABORTED
    // after iteration 1. (A red ladder never reaches Sign-off, so no LLM is ever invoked.)
    const first = await captureAll(() =>
      main(['run', 'g', '--verify-cmd', 'false', '--harness', 'fake', '--autonomous',
        '--max-iterations', '2', '--workspace', root]),
    );
    expect(first.code).toBe(1);
    expect(first.out).toContain('no-diff');
    const runId = /── goaly run (run-[0-9a-f-]+) ──/.exec(first.out)?.[1];
    expect(runId).toBeDefined();

    // Resume with an operator override + note: the fold revives past the no-diff abort, runs
    // iteration 2 (still red), and now terminates at the iteration cap instead.
    const second = await captureAll(() =>
      main(['run', 'g', '--verify-cmd', 'false', '--harness', 'fake', '--autonomous',
        '--workspace', root, '--resume', runId!,
        '--stuck-no-diff', 'false', '--note', 'the fixture is in f.txt']),
    );
    expect(second.code).toBe(1);
    expect(second.out).toContain('iterations:  2');
    expect(second.out).toContain('reached maxIterations');
  });

  it('refuses to extend a DONE run, pointing at --from-run', async () => {
    // Fabricate a DONE run log directly (no LLM/harness involved): both keys turned.
    const contract = makeFakeContract({ goal: 'g' });
    const log = new FileRunLog(join(root, STATE_DIR, 'run-done'));
    await log.writeHeader({
      runId: RunId.parse('run-done'),
      startedAt: 1,
      config: makeConfig({ goal: 'g' }),
      harness: 'fake',
    });
    const base = { runId: RunId.parse('run-done'), contractHash: contract.contractHash };
    await log.append({ ...base, seq: 1, ts: 1, event: { tag: 'CONTRACT_COMPILED', contract }, stateTagAfter: 'AWAIT_SEAL' });
    await log.append({ ...base, seq: 2, ts: 2, event: { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }, stateTagAfter: 'RUNNING_AGENT' });
    await log.append({
      ...base, seq: 3, ts: 3,
      event: {
        tag: 'AGENT_RAN',
        run: { output: 'ok', sessionId: SessionId.parse('s1'), status: 'completed' },
        prevDiffHash: DiffHash.parse('0000000'),
        diffHash: DiffHash.parse('0000001'),
        budget: { exceeded: false },
      },
      stateTagAfter: 'VERIFYING',
    });
    await log.append({ ...base, seq: 4, ts: 4, event: { tag: 'VERIFIED', verdict: { pass: true, confidence: 1, detail: 'green' } }, stateTagAfter: 'AWAIT_SIGNOFF' });
    await log.append({ ...base, seq: 5, ts: 5, event: { tag: 'SIGNOFF_DECIDED', approval: { veto: false } }, stateTagAfter: 'DONE' });

    const res = await captureAll(() =>
      main(['run', 'g', '--verify-cmd', 'true', '--harness', 'fake', '--autonomous',
        '--workspace', root, '--resume', 'run-done', '--max-iterations', '5']),
    );
    expect(res.code).toBe(2);
    expect(res.out).toContain('nothing to extend');
    expect(res.out).toContain('--from-run');
  });
});

describe('main() — follow-up (Capability C) guards & resume-cmd (Capability A)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-main-followup-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await fn(), err: writes.join('') };
    } finally {
      process.stderr.write = orig;
    }
  }

  async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      writes.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      return { code: await fn(), out: writes.join('') };
    } finally {
      process.stdout.write = orig;
    }
  }

  it('exits 2 when --from-run points at a non-existent run', async () => {
    const { code, err } = await captureStderr(() =>
      main(['run', 'follow up', '--harness', 'fake', '--autonomous', '--workspace', root,
        '--from-run', 'run-nope']),
    );
    expect(code).toBe(2);
    expect(err).toContain('--from-run run-nope');
    expect(err).toContain('no such run');
  });

  it('refuses to start (exit 2) when another live process holds the run lock', async () => {
    // A real (resumable) run log in a real git repo, so preflight and the --resume existence check
    // both pass and the run-lock guard is what fires.
    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git('init', '-q');
    const log = new FileRunLog(join(root, STATE_DIR, 'run-locked'));
    await log.writeHeader({
      runId: RunId.parse('run-locked'),
      startedAt: 1,
      config: makeConfig(),
      harness: 'fake',
    });
    // Pre-hold the lock with pid 1 (always alive, and never this test process).
    await writeFile(join(root, STATE_DIR, 'run-locked', 'run.lock'), '1\n', 'utf8');
    const { code, err } = await captureStderr(() =>
      main(['run', 'g', '--verify-cmd', 'true', '--harness', 'fake', '--autonomous',
        '--workspace', root, '--resume', 'run-locked']),
    );
    expect(code).toBe(2);
    expect(err).toContain('another goaly process');
  });

  it('exits 2 with a pointer to runs list when --resume names a non-existent run', async () => {
    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git('init', '-q');
    const { code, err } = await captureStderr(() =>
      main(['run', 'g', '--verify-cmd', 'true', '--harness', 'fake', '--autonomous',
        '--workspace', root, '--resume', 'run-nope']),
    );
    expect(code).toBe(2);
    expect(err).toContain('--resume run-nope');
    expect(err).toContain('no such run');
    expect(err).toContain('runs list');
  });

  it('exits 2 with git guidance when the workspace is not a git repository', async () => {
    // `root` is a bare temp dir (no git init) — the preflight must say so BEFORE any spend.
    const { code, err } = await captureStderr(() =>
      main(['run', 'g', '--verify-cmd', 'true', '--harness', 'fake', '--autonomous',
        '--workspace', root]),
    );
    expect(code).toBe(2);
    expect(err).toContain('not a git repository');
    expect(err).toContain('git init');
  });

  it('exits 2 when --inherit-session is used without --from-run', async () => {
    const { code, err } = await captureStderr(() =>
      main(['run', 'g', '--verify-cmd', 'true', '--harness', 'fake', '--autonomous',
        '--workspace', root, '--inherit-session']),
    );
    expect(code).toBe(2);
    expect(err).toContain('--inherit-session requires --from-run');
  });

  it('runs resume-cmd prints the harness-correct command from a recorded run (Capability A)', async () => {
    // Write a VALID run log (compile → seal → agent turn) with a recorded harness + real session id.
    const runId = 'run-A';
    const contract = makeFakeContract({ goal: 'g' });
    const log = new FileRunLog(join(root, STATE_DIR, runId));
    await log.writeHeader({
      runId: RunId.parse(runId),
      startedAt: 1_700_000_000_000,
      config: makeConfig({ goal: 'g' }),
      harness: 'claude',
    });
    const mk = (seq: number, event: Parameters<typeof log.append>[0]['event']) => ({
      runId: RunId.parse(runId),
      seq,
      ts: 1_700_000_000_000 + seq,
      contractHash: null,
      event,
      stateTagAfter: 'x',
    });
    await log.append(mk(1, { tag: 'CONTRACT_COMPILED', contract }));
    await log.append(mk(2, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }));
    await log.append(
      mk(3, {
        tag: 'AGENT_RAN',
        run: { output: '', sessionId: SessionId.parse('claude-real-1'), status: 'completed' },
        prevDiffHash: DiffHash.parse('0000000'),
        diffHash: DiffHash.parse('0000001'),
        budget: { exceeded: false },
      }),
    );

    const { code, out } = await captureStdout(() =>
      main(['runs', 'resume-cmd', runId, '--workspace', root]),
    );
    expect(code).toBe(0);
    expect(out).toContain('claude --resume claude-real-1');
  });
});
