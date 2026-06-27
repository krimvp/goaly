/**
 * Slice 2 — the eval bench. A fixed, deterministic set of goaly tasks `(goal, verify-cmd[, seed])`,
 * each ladder-checkable, used to compare harnesses (goaly-code on a frontier model vs. claude/codex)
 * and, later, to gate each new trained model — strictly held out from any training/synthetic data.
 *
 * The tasks are pure data (seed files are inline strings, so a task is serializable and reproducible).
 * The RUN is injected (`RunTaskFn`) so the bench library is testable with a fake runner and the live
 * runner wires real `composeDeps` + `drive`. Metrics: pass@1 (ladder + approver), iterations to
 * converge, token cost.
 */

import type { RunStatus } from '../runlog/inspect';

/** One bench task. `seedFiles` are written into the fresh workspace before the run (path → content). */
export type BenchTask = {
  readonly id: string;
  readonly goal: string;
  readonly verifyCmd: string;
  readonly seedFiles?: Readonly<Record<string, string>>;
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
];

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
