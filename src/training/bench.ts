/**
 * Slice 2 — the eval bench. A fixed, deterministic set of goaly tasks `(goal, verify-cmd[, seed])`,
 * each ladder-checkable, used to compare harnesses and, later, to gate trained models. The product
 * tasks below have separate oracle checks. A runner must keep those checks out of the worker tree.
 *
 * The tasks are pure data (seed files are inline strings, so a task is serializable and reproducible).
 * The RUN is injected (`RunTaskFn`) so the bench library is testable with a fake runner and the live
 * runner wires the real goaly CLI. `summarizeBench` counts Goaly DONE; the product classification
 * below separately compares that status with the external oracle.
 */

import type { RunStatus } from '../runlog/inspect';

/** One bench task. `seedFiles` are written into the fresh workspace before the run (path → content). */
export type BenchTask = {
  readonly id: string;
  readonly goal: string;
  readonly verifyCmd: string;
  readonly seedFiles?: Readonly<Record<string, string>>;
  /** External oracle identifier. Its checks stay outside the worker workspace. */
  readonly oracleId?: string;
};

/** The held-out bench. Small, deterministic, runtime-checkable; covers create / structured / fix. */
export const BENCH_TASKS: readonly BenchTask[] = [
  {
    id: 'create-file',
    goal: 'Create a file named hello.txt whose contents are exactly the single line: hello world',
    verifyCmd: 'test -f hello.txt && grep -qx "hello world" hello.txt',
  },
  {
    id: 'json-config',
    goal: 'Create a file config.json containing valid JSON with a top-level key "version" whose value is the number 1.',
    verifyCmd: 'node -e "process.exit(require(\'./config.json\').version===1?0:1)"',
  },
  {
    id: 'fix-bug',
    goal: 'The function add in add.js should return the SUM of its two arguments, but it is wrong. Fix it so the test passes.',
    verifyCmd: 'node test.js',
    seedFiles: {
      'add.js': 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n',
      'test.js':
        'const { add } = require("./add");\nif (add(2, 3) !== 5) { console.error("FAIL: add(2,3) =", add(2,3)); process.exit(1); }\nconsole.log("ok");\n',
    },
  },
  {
    id: 'append-line',
    goal: 'Append a new line containing exactly "second" to the existing file notes.txt, keeping the first line "first".',
    verifyCmd: 'test "$(cat notes.txt)" = "$(printf \'first\\nsecond\')"',
    seedFiles: { 'notes.txt': 'first\n' },
  },
  {
    id: 'order-pricing',
    goal: 'Fix src/price.cjs and src/receipt.cjs. priceCents(unitCents, quantity, discountPercent) must return the integer total after a percentage discount, rounded once to the nearest cent; clamp discounts to 0..100. receipt(items, taxPercent) must sum each priced line, then add tax rounded once to the nearest cent. It must return {subtotalCents, taxCents, totalCents} and must not change input items.',
    verifyCmd: 'node test.cjs',
    oracleId: 'order-pricing',
    seedFiles: {
      'src/price.cjs': 'exports.priceCents = (unitCents, quantity, discountPercent) => Math.round(unitCents * (1 - discountPercent / 100)) * quantity;\n',
      'src/receipt.cjs': 'const { priceCents } = require("./price.cjs");\nexports.receipt = (items, taxPercent) => {\n  const subtotalCents = items.reduce((sum, item) => sum + priceCents(item.unitCents, item.quantity, item.discountPercent), 0);\n  return { subtotalCents, taxCents: 0, totalCents: subtotalCents };\n};\n',
      'test.cjs': 'const assert = require("node:assert/strict");\nconst { priceCents } = require("./src/price.cjs");\nconst { receipt } = require("./src/receipt.cjs");\nassert.equal(priceCents(100, 2, 10), 180);\nassert.deepEqual(receipt([{ unitCents: 100, quantity: 2, discountPercent: 0 }], 10), { subtotalCents: 200, taxCents: 20, totalCents: 220 });\n',
    },
  },
  {
    id: 'event-report',
    goal: 'Fix src/parse.cjs and src/report.cjs. parseLine(line) accepts kind|count rows: trim the kind, require a nonempty kind and a nonnegative integer count, and return null for blank or invalid rows. summarize(text) must parse all lines, ignore invalid rows, sum counts by kind, and return an array of {kind, count} sorted by kind. It must not include prototype keys from Object.prototype.',
    verifyCmd: 'node test.cjs',
    oracleId: 'event-report',
    seedFiles: {
      'src/parse.cjs': 'exports.parseLine = (line) => { const [kind, count] = line.split("|"); return { kind, count: Number(count) }; };\n',
      'src/report.cjs': 'const { parseLine } = require("./parse.cjs");\nexports.summarize = (text) => text.split("\\n").map(parseLine);\n',
      'test.cjs': 'const assert = require("node:assert/strict");\nconst { parseLine } = require("./src/parse.cjs");\nconst { summarize } = require("./src/report.cjs");\nassert.deepEqual(parseLine("red|2"), { kind: "red", count: 2 });\nassert.deepEqual(summarize("red|2\\nblue|3\\nred|1"), [{ kind: "blue", count: 3 }, { kind: "red", count: 3 }]);\n',
    },
  },
];

export type ProductBenchResult = BenchResult & {
  readonly oraclePassed: boolean | null;
  readonly oracleDetail: string;
  readonly elapsedMs: number;
  readonly attempts?: number;
  readonly hadRejectedAttempt?: boolean;
  readonly runId?: string;
  readonly evidence?: {
    readonly workspace: string;
    readonly runLogDir: string | null;
    readonly oracleSha256: string;
    readonly harness: string;
    readonly llmProvider: string;
    readonly model: string;
    readonly degraded: unknown;
    readonly usage?: unknown;
  };
};

export type ProductClassification = 'true-done' | 'false-done' | 'false-red' | 'true-red' | 'unresolved';

export function classifyProductResult(result: ProductBenchResult): ProductClassification {
  if (result.oraclePassed === null || (result.status !== 'DONE' && result.iterations === 0)) return 'unresolved';
  if (result.status === 'DONE') return result.oraclePassed ? 'true-done' : 'false-done';
  return result.oraclePassed ? 'false-red' : 'true-red';
}

export function summarizeProductBench(results: readonly ProductBenchResult[]) {
  const counts: Record<ProductClassification, number> = {
    'true-done': 0,
    'false-done': 0,
    'false-red': 0,
    'true-red': 0,
    unresolved: 0,
  };
  for (const result of results) counts[classifyProductResult(result)]++;
  const known = results.filter((r) => r.oraclePassed !== null);
  const recoverable = results.filter((r) => r.hadRejectedAttempt === true);
  return {
    counts,
    tasks: results.length,
    completionRate: results.length === 0 ? 0 : results.filter((r) => r.status === 'DONE').length / results.length,
    oraclePassRate: known.length === 0 ? null : known.filter((r) => r.oraclePassed === true).length / known.length,
    totalAttempts: results.reduce((sum, r) => sum + (r.attempts ?? r.iterations), 0),
    reportedTokens: results.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
    unknownTokenRuns: results.filter((r) => r.tokens === undefined).length,
    totalElapsedMs: results.reduce((sum, r) => sum + r.elapsedMs, 0),
    recoveryOpportunities: recoverable.length,
    recoveryRate: recoverable.length === 0 ? null : recoverable.filter((r) => r.status === 'DONE').length / recoverable.length,
  };
}

/** The outcome of running one bench task. */
export type BenchResult = {
  readonly taskId: string;
  readonly status: RunStatus;
  /** pass@1: the run reached DONE (frozen ladder passed AND approver did not veto). */
  readonly passed: boolean;
  readonly iterations: number;
  readonly tokens: number | undefined;
  /** Set when the run itself errored (the runner caught it); the task counts as not-passed. */
  readonly error?: string;
};

/** The injected per-task runner (live: compose goaly-code + drive in a fresh repo; tests: a fake). */
export type RunTaskFn = (task: BenchTask) => Promise<BenchResult>;

/** Run every task in order (sequential — kind to a rate-limited endpoint). Never throws per task. */
export async function runBench(
  tasks: readonly BenchTask[],
  runTask: RunTaskFn,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const task of tasks) {
    try {
      results.push(await runTask(task));
    } catch (e) {
      results.push({
        taskId: task.id,
        status: 'INCOMPLETE',
        passed: false,
        iterations: 0,
        tokens: undefined,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

export type BenchSummary = {
  readonly tasks: number;
  readonly passed: number;
  /** Fraction in [0,1] that reached DONE. */
  readonly passAt1: number;
  /** Mean iterations across PASSED tasks (0 when none passed). */
  readonly avgIterationsToPass: number;
  /** Sum of reported tokens across all tasks (undefined contributions skipped). */
  readonly totalTokens: number;
};

/** Aggregate bench results into headline metrics. */
export function summarizeBench(results: readonly BenchResult[]): BenchSummary {
  const passed = results.filter((r) => r.passed);
  const totalTokens = results.reduce((acc, r) => acc + (r.tokens ?? 0), 0);
  const avgIterationsToPass =
    passed.length === 0 ? 0 : passed.reduce((acc, r) => acc + r.iterations, 0) / passed.length;
  return {
    tasks: results.length,
    passed: passed.length,
    passAt1: results.length === 0 ? 0 : passed.length / results.length,
    avgIterationsToPass,
    totalTokens,
  };
}
