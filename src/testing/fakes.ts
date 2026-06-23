import { SessionId, DiffHash } from '../domain/ids';
import { HarnessRunResult, type BudgetSnapshot, type ApprovalInput } from '../domain/events';
import { type Verdict, type ApprovalVerdict, type SealDecision } from '../domain/verdict';
import type { CompiledContract, Rung, UnhashedContract } from '../domain/contract';
import type { PhasePlan, UnhashedPlan } from '../domain/plan';
import { RunConfig, type RunConfigInput } from '../domain/config';
import { initialCtx, type LoopCtx } from '../orchestrator/state';
import type { HarnessAdapter } from '../harness/adapter';
import type { Verifier } from '../verify/verifier';
import type { Approver } from '../verify/approver';
import type { VerifierCompiler } from '../compile/compiler';
import type { SealGate } from '../compile/seal';
import type { Planner } from '../plan/planner';
import type { PlanGate } from '../plan/plan-gate';
import type { Workspace, CommandResult } from '../workspace/workspace';
import type { Clock } from '../driver/clock';
import type { BudgetMeter } from '../driver/budget';
import type { RunLog, RunLogHeader, RunLogEntry } from '../runlog/runlog';
import { StructuredLogger, type Logger, type LogLevel, type LogRecord } from '../log/logger';
import type { LogFs } from '../log/sinks';
import { freezeContract, freezePlan } from '../util/hash';

/** Build a frozen contract for tests (defaults to a single deterministic rung). */
export function makeFakeContract(overrides: Partial<UnhashedContract> = {}): CompiledContract {
  const base: UnhashedContract = {
    goal: 'make the thing work',
    rungs: [{ kind: 'deterministic', command: 'true' }] satisfies Rung[],
    rubric: '',
    generatedFiles: [],
  };
  return freezeContract({ ...base, ...overrides });
}

/** Build a frozen plan for tests (issue #48); defaults to two simple ordered sub-goals. */
export function makeFakePlan(overrides: Partial<UnhashedPlan> = {}): PhasePlan {
  const base: UnhashedPlan = {
    phases: [{ goal: 'phase one' }, { goal: 'phase two' }],
  };
  return freezePlan({ ...base, ...overrides });
}

export type FakeRunScript = {
  output?: string;
  status?: HarnessRunResult['status'];
  tokensUsed?: number;
  /** When set (with a wired FakeWorkspace), advances the workspace hash, simulating a change. */
  postHash?: string;
  /**
   * When set (with a wired FakeWorkspace), updates the `.gitignore` content hash during the run —
   * simulates the agent adding/editing a `.gitignore` entry mid-run (the gitignore-change warning).
   */
  gitignoreHash?: string;
  /** When set, `run()` throws — used to simulate a mid-loop crash for resume tests. */
  throwError?: string;
};

/** Scripted harness. Echoes a resumed session id; mints one on the first run. */
export class FakeHarness implements HarnessAdapter {
  readonly name = 'fake';
  #i = 0;
  readonly #scripts: FakeRunScript[];
  readonly #workspace: FakeWorkspace | undefined;
  readonly prompts: string[] = [];

  constructor(scripts: FakeRunScript[], workspace?: FakeWorkspace) {
    this.#scripts = scripts;
    this.#workspace = workspace;
  }

  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    this.prompts.push(prompt);
    const s = this.#scripts[this.#i] ?? {};
    this.#i += 1;
    if (s.throwError !== undefined) throw new Error(s.throwError);
    if (s.postHash !== undefined && this.#workspace !== undefined) {
      this.#workspace.setHash(s.postHash);
    }
    if (s.gitignoreHash !== undefined && this.#workspace !== undefined) {
      this.#workspace.setFileHash('.gitignore', s.gitignoreHash);
    }
    const sid = sessionId ?? SessionId.parse('fake-session-1');
    return HarnessRunResult.parse({
      output: s.output ?? '',
      sessionId: sid,
      status: s.status ?? 'completed',
      ...(s.tokensUsed !== undefined ? { tokensUsed: s.tokensUsed } : {}),
    });
  }
}

/** Scripted verifier (the test's stand-in for a real ladder). Repeats the last verdict. */
export class FakeVerifier implements Verifier {
  #i = 0;
  readonly #verdicts: Verdict[];
  constructor(verdicts: Verdict[]) {
    this.#verdicts = verdicts;
  }
  async verify(): Promise<Verdict> {
    const v = this.#verdicts[this.#i] ?? this.#verdicts[this.#verdicts.length - 1];
    this.#i += 1;
    if (v === undefined) throw new Error('FakeVerifier has no verdicts scripted');
    return v;
  }
}

/** Scripted approver. Defaults to no-veto once the script is exhausted. */
export class FakeApprover implements Approver {
  #i = 0;
  readonly #approvals: ApprovalVerdict[];
  readonly inputs: ApprovalInput[] = [];
  constructor(approvals: ApprovalVerdict[]) {
    this.#approvals = approvals;
  }
  async review(input: ApprovalInput): Promise<ApprovalVerdict> {
    this.inputs.push(input);
    const a = this.#approvals[this.#i] ?? { veto: false };
    this.#i += 1;
    return a;
  }
}

export class FakeCompiler implements VerifierCompiler {
  readonly #contracts: (CompiledContract | Error)[];
  #i = 0;
  /** The `feedback` arg of each compile() call, in order (undefined when none was passed). */
  readonly feedbacks: (string | undefined)[] = [];
  /** The config of each compile() call, in order. */
  readonly configs: RunConfig[] = [];

  constructor(contract: CompiledContract | Error | (CompiledContract | Error)[]) {
    this.#contracts = Array.isArray(contract) ? contract : [contract];
  }

  async compile(config: RunConfig, feedback?: string): Promise<CompiledContract> {
    this.configs.push(config);
    this.feedbacks.push(feedback);
    // Clamp to the last scripted entry so a single-element script keeps returning it.
    const idx = Math.min(this.#i, this.#contracts.length - 1);
    this.#i += 1;
    const next = this.#contracts[idx];
    if (next === undefined) throw new Error('FakeCompiler: no contract scripted');
    if (next instanceof Error) throw next;
    return next;
  }
}

/** Scripted planner (issue #48). Clamps to the last entry; an Error entry throws (→ PLAN_FAILED). */
export class FakePlanner implements Planner {
  readonly #plans: (PhasePlan | Error)[];
  #i = 0;
  /** The `feedback` arg of each plan() call, in order (undefined when none was passed). */
  readonly feedbacks: (string | undefined)[] = [];
  /** The config of each plan() call, in order. */
  readonly configs: RunConfig[] = [];

  constructor(plan: PhasePlan | Error | (PhasePlan | Error)[]) {
    this.#plans = Array.isArray(plan) ? plan : [plan];
  }

  async plan(config: RunConfig, feedback?: string): Promise<PhasePlan> {
    this.configs.push(config);
    this.feedbacks.push(feedback);
    const idx = Math.min(this.#i, this.#plans.length - 1);
    this.#i += 1;
    const next = this.#plans[idx];
    if (next === undefined) throw new Error('FakePlanner: no plan scripted');
    if (next instanceof Error) throw next;
    return next;
  }
}

/** Scripted plan Seal gate (issue #48). Defaults to approve; clamps to the last decision. */
export class FakePlanGate implements PlanGate {
  readonly #decisions: SealDecision[];
  #i = 0;
  readonly seen: PhasePlan[] = [];

  constructor(decision: SealDecision | SealDecision[] = { kind: 'approve' }) {
    this.#decisions = Array.isArray(decision) ? decision : [decision];
  }

  async approvePlan(plan: PhasePlan): Promise<SealDecision> {
    this.seen.push(plan);
    const idx = Math.min(this.#i, this.#decisions.length - 1);
    this.#i += 1;
    const next = this.#decisions[idx];
    if (next === undefined) throw new Error('FakePlanGate: no decision scripted');
    return next;
  }
}

export class FakeSealGate implements SealGate {
  readonly #decisions: SealDecision[];
  #i = 0;
  readonly seen: CompiledContract[] = [];

  constructor(decision: SealDecision | SealDecision[] = { kind: 'approve' }) {
    this.#decisions = Array.isArray(decision) ? decision : [decision];
  }

  async approveContract(contract: CompiledContract): Promise<SealDecision> {
    this.seen.push(contract);
    const idx = Math.min(this.#i, this.#decisions.length - 1);
    this.#i += 1;
    const next = this.#decisions[idx];
    if (next === undefined) throw new Error('FakeSealGate: no decision scripted');
    return next;
  }
}

export class FakeWorkspace implements Workspace {
  #hash: string;
  #diffText: string;
  readonly #cmdResults: CommandResult[];
  readonly #fileHashes: Map<string, string> = new Map();
  /** Every baseline `setBaseline()`/`checkpoint()` adopted, in order — for asserting resume wiring. */
  readonly baselineCalls: string[] = [];
  constructor(hash = '0000000', diffText = '', cmdResults: CommandResult[] = []) {
    this.#hash = hash;
    this.#diffText = diffText;
    this.#cmdResults = [...cmdResults];
  }
  setHash(hash: string): void {
    this.#hash = hash;
  }
  /** The currently-active diff baseline (the last one adopted), or undefined if none was set. */
  get baseline(): string | undefined {
    return this.baselineCalls[this.baselineCalls.length - 1];
  }
  setBaseline(ref: string): void {
    this.baselineCalls.push(ref);
  }
  /** Snapshot the current tree hash as the new baseline and return it (no real git). */
  async checkpoint(): Promise<DiffHash> {
    const tree = DiffHash.parse(this.#hash);
    this.baselineCalls.push(tree);
    return tree;
  }
  /** Stub a file's content hash (the integrity guard reads this); `null` clears it (simulates deletion). */
  setFileHash(relPath: string, sha256: string | null): void {
    if (sha256 === null) this.#fileHashes.delete(relPath);
    else this.#fileHashes.set(relPath, sha256);
  }
  async diffHash(): Promise<DiffHash> {
    return DiffHash.parse(this.#hash);
  }
  async diff(): Promise<string> {
    return this.#diffText;
  }
  async run(_command: string): Promise<CommandResult> {
    return this.#cmdResults.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
  }
  async fileHash(relPath: string): Promise<string | null> {
    return this.#fileHashes.get(relPath) ?? null;
  }
}

export class ManualClock implements Clock {
  #t: number;
  constructor(start = 0) {
    this.#t = start;
  }
  now(): number {
    return this.#t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
  set(ms: number): void {
    this.#t = ms;
  }
}

export class ManualBudgetMeter implements BudgetMeter {
  #tokens = 0;
  #exceeded: boolean;
  constructor(exceeded = false) {
    this.#exceeded = exceeded;
  }
  record(tokensUsed: number | undefined): void {
    if (tokensUsed !== undefined) this.#tokens += tokensUsed;
  }
  setExceeded(exceeded: boolean): void {
    this.#exceeded = exceeded;
  }
  snapshot(): BudgetSnapshot {
    return { tokensSpent: this.#tokens, exceeded: this.#exceeded };
  }
}

export class InMemoryRunLog implements RunLog {
  header: RunLogHeader | null = null;
  entries: RunLogEntry[] = [];
  async writeHeader(header: RunLogHeader): Promise<void> {
    this.header = header;
  }
  async append(entry: RunLogEntry): Promise<void> {
    this.entries.push(entry);
  }
  async read(): Promise<{ header: RunLogHeader; entries: RunLogEntry[] } | null> {
    if (this.header === null) return null;
    return { header: this.header, entries: [...this.entries] };
  }
}

/** A logger backed by a captured-records sink, with a deterministic counter clock. */
export function recordingLogger(level: LogLevel = 'debug'): {
  logger: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  let t = 0;
  const logger = new StructuredLogger({
    level,
    sinks: [{ write: (r) => records.push(r) }],
    now: () => (t += 1),
  });
  return { logger, records };
}

/** In-memory {@link LogFs} for rotating-sink tests — never touches disk. */
export class InMemoryLogFs implements LogFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  size(path: string): number | null {
    const f = this.files.get(path);
    return f === undefined ? null : Buffer.byteLength(f, 'utf8');
  }
  append(path: string, data: string): void {
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  rename(from: string, to: string): void {
    const f = this.files.get(from);
    if (f === undefined) return;
    this.files.set(to, f);
    this.files.delete(from);
  }
  remove(path: string): void {
    this.files.delete(path);
  }
  ensureDir(dir: string): void {
    this.dirs.add(dir);
  }
}

// ---- convenient verdict/approval builders for tests -----------------------

export const passVerdict = (detail = 'all checks passed'): Verdict => ({
  pass: true,
  confidence: 1,
  detail,
});
export const failVerdict = (detail = 'check failed'): Verdict => ({
  pass: false,
  confidence: 1,
  detail,
});
export const veto = (reason: string): ApprovalVerdict => ({ veto: true, reason });
export const approve = (): ApprovalVerdict => ({ veto: false });

/** A valid RunConfig for tests (deterministic verifier by default). */
export function makeConfig(overrides: Partial<RunConfigInput> = {}): RunConfig {
  return RunConfig.parse({
    goal: 'g',
    verifier: { kind: 'existing', ref: 'true' },
    ...overrides,
  } satisfies RunConfigInput);
}

/** A LoopCtx with sensible defaults (iteration 1) for DECIDE/stuck table tests. */
export function makeCtx(overrides: Partial<LoopCtx> = {}): LoopCtx {
  const config = overrides.config ?? makeConfig();
  const contract = overrides.contract ?? makeFakeContract();
  return { ...initialCtx(config, contract), iteration: 1, ...overrides };
}

/** Branded DiffHash list from short hex labels — for oscillation/no-diff tests. */
export function dh(...hexes: string[]): DiffHash[] {
  return hexes.map((h) => DiffHash.parse(h.padStart(7, '0')));
}
