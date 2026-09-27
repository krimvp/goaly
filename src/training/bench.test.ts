import { describe, it, expect } from 'vitest';
import { BENCH_TASKS, runBench, summarizeBench, classifyProductResult, summarizeProductBench, type BenchResult, type BenchTask, type ProductBenchResult } from './bench';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../util/spawn';

describe('BENCH_TASKS', () => {
  it('are deterministic, uniquely-identified, ladder-checkable tasks', () => {
    const ids = BENCH_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const t of BENCH_TASKS) {
      expect(t.goal.length).toBeGreaterThan(0);
      expect(t.verifyCmd.length).toBeGreaterThan(0);
    }
  });
});

describe('runBench', () => {
  const result = (over: Partial<BenchResult>): BenchResult => ({
    taskId: 't',
    status: 'DONE',
    passed: true,
    iterations: 1,
    tokens: 100,
    ...over,
  });

  it('runs each task through the injected runner, in order', async () => {
    const seen: string[] = [];
    const runTask = async (task: BenchTask): Promise<BenchResult> => {
      seen.push(task.id);
      return result({ taskId: task.id });
    };
    const tasks: BenchTask[] = [
      { id: 'a', goal: 'g', verifyCmd: 'true' },
      { id: 'b', goal: 'g', verifyCmd: 'true' },
    ];
    const results = await runBench(tasks, runTask);
    expect(seen).toEqual(['a', 'b']);
    expect(results.map((r) => r.taskId)).toEqual(['a', 'b']);
  });

  it('catches a throwing runner into a not-passed INCOMPLETE result (never throws)', async () => {
    const tasks: BenchTask[] = [{ id: 'boom', goal: 'g', verifyCmd: 'true' }];
    const results = await runBench(tasks, async () => {
      throw new Error('endpoint down');
    });
    expect(results[0]).toMatchObject({ taskId: 'boom', status: 'INCOMPLETE', passed: false });
    expect(results[0]!.error).toMatch(/endpoint down/);
  });
});

describe('summarizeBench', () => {
  const r = (over: Partial<BenchResult>): BenchResult => ({
    taskId: 't',
    status: 'DONE',
    passed: true,
    iterations: 1,
    tokens: 100,
    ...over,
  });

  it('computes pass@1, average iterations-to-pass, and total tokens', () => {
    const results = [
      r({ taskId: 'a', passed: true, iterations: 1, tokens: 100 }),
      r({ taskId: 'b', passed: true, iterations: 3, tokens: 200 }),
      r({ taskId: 'c', passed: false, status: 'FAILED', iterations: 4, tokens: 50 }),
    ];
    const s = summarizeBench(results);
    expect(s.tasks).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.passAt1).toBeCloseTo(2 / 3);
    expect(s.avgIterationsToPass).toBe(2); // (1+3)/2, failed task excluded
    expect(s.totalTokens).toBe(350);
  });

  it('handles an all-failed bench without dividing by zero', () => {
    const s = summarizeBench([r({ passed: false, status: 'FAILED', tokens: undefined })]);
    expect(s.passAt1).toBe(0);
    expect(s.avgIterationsToPass).toBe(0);
    expect(s.totalTokens).toBe(0);
  });
});

describe('independent product checks', () => {
  it('classifies false DONE, false red, and oracle errors separately', () => {
    const base: ProductBenchResult = {
      taskId: 't', status: 'DONE', passed: true, iterations: 2, tokens: 100,
      oraclePassed: true, oracleDetail: 'ok', elapsedMs: 500,
    };
    expect(classifyProductResult(base)).toBe('true-done');
    expect(classifyProductResult({ ...base, oraclePassed: false })).toBe('false-done');
    expect(classifyProductResult({ ...base, status: 'FAILED', passed: false })).toBe('false-red');
    expect(classifyProductResult({ ...base, status: 'FAILED', passed: false, oraclePassed: false })).toBe('true-red');
    expect(classifyProductResult({ ...base, oraclePassed: null })).toBe('unresolved');
    expect(classifyProductResult({ ...base, status: 'ABORTED', passed: false, iterations: 0, oraclePassed: false })).toBe('unresolved');
    expect(summarizeProductBench([
      base,
      { ...base, oraclePassed: false },
      { ...base, status: 'FAILED', passed: false },
    ])).toMatchObject({ counts: { 'true-done': 1, 'false-done': 1, 'false-red': 1 }, completionRate: 2 / 3 });
    expect(summarizeProductBench([{ ...base, status: 'DONE', hadRejectedAttempt: true, attempts: 2 }]))
      .toMatchObject({ totalAttempts: 2, recoveryOpportunities: 1, recoveryRate: 1 });
  });

  it('keeps withheld oracle code out of each seeded worker workspace', async () => {
    const oracle = fileURLToPath(new URL('../../evaluation/oracle.cjs', import.meta.url));
    for (const task of BENCH_TASKS.filter((t) => t.oracleId !== undefined)) {
      const root = await mkdtemp(join(tmpdir(), `goaly-bench-${task.id}-`));
      for (const [path, content] of Object.entries(task.seedFiles ?? {})) {
        const full = join(root, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
      }
      expect(await readdir(root)).not.toContain('oracle.cjs');
      const result = await runProcess(process.execPath, [oracle, task.oracleId!, root], {
        cwd: root, timeoutMs: 5000,
      });
      expect(result.code).not.toBe(0);
      expect(result.timedOut).toBe(false);
    }
  });
});
