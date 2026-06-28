import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatOutcome, main } from './main';
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
