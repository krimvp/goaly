import { mkdir, writeFile, readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BENCH_TASKS, classifyProductResult, summarizeProductBench, type BenchTask, type ProductBenchResult } from '../src/training/bench';
import { listRuns, readRun } from '../src/runlog/inspect';
import { runProcess } from '../src/util/spawn';
import { scrubEnv } from '../src/workspace/scrub-env';

const repo = fileURLToPath(new URL('..', import.meta.url));
const oracle = join(repo, 'evaluation', 'oracle.cjs');
const goaly = join(repo, 'src', 'cli', 'bin.ts');
const argv = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
};

async function runTask(task: BenchTask, output: string, model: string | undefined): Promise<ProductBenchResult> {
  const taskDir = join(output, task.id);
  const workspace = await mkdtemp(join(tmpdir(), `goaly-product-${task.id}-`));
  await mkdir(taskDir);
  for (const [name, content] of Object.entries(task.seedFiles ?? {})) {
    const target = join(workspace, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  const args = [
    '--import', 'tsx', goaly, 'run', '--workspace', workspace, '--workspace-mode', 'file',
    '--goal', task.goal, '--verify-cmd', task.verifyCmd,
    '--harness', 'codex', '--llm-provider', 'codex', '--autonomous',
    '--max-iterations', '2', '--budget-tokens', '300000', '--budget-wall-ms', '180000',
    '--harness-timeout-ms', '90000', '--llm-timeout-ms', '60000', '--verify-timeout-ms', '10000',
    ...(model === undefined ? [] : ['--model', model]),
  ];
  const startedAt = Date.now();
  const run = await runProcess(process.execPath, args, {
    cwd: repo, env: process.env, timeoutMs: 200000, killGroup: true,
  });
  const elapsedMs = Date.now() - startedAt;
  await writeFile(join(taskDir, 'goaly-stdout.txt'), run.stdout);
  await writeFile(join(taskDir, 'goaly-stderr.txt'), run.stderr);
  const oracleSha256 = createHash('sha256').update(await readFile(oracle)).digest('hex');
  await writeFile(join(taskDir, 'command.json'), JSON.stringify({
    command: process.execPath, args, cwd: repo, exitCode: run.code,
    timedOut: run.timedOut, outputCapped: run.truncated === true,
    startedAt, elapsedMs, harness: 'codex', llmProvider: 'codex',
    model: model ?? 'Codex CLI default (not resolved by this evaluator)',
    oracleSha256,
  }, null, 2));

  const stateDir = join(workspace, '.goaly');
  const listed = (await listRuns(stateDir)).find((item) => item.ok);
  const inspected = listed?.ok ? await readRun(stateDir, listed.summary.runId) : null;
  const detail = inspected?.ok ? inspected.detail : undefined;
  const oracleRun = await runProcess(process.execPath, [oracle, task.oracleId ?? task.id, workspace], {
    cwd: workspace, env: scrubEnv(process.env), timeoutMs: 10000, killGroup: true,
  });
  await writeFile(join(taskDir, 'oracle-stdout.txt'), oracleRun.stdout);
  await writeFile(join(taskDir, 'oracle-stderr.txt'), oracleRun.stderr);
  const oraclePassed = oracleRun.timedOut || oracleRun.truncated || oracleRun.code === 127 ? null : oracleRun.code === 0;
  const savedWorkspace = join(taskDir, 'workspace');
  await cp(workspace, savedWorkspace, { recursive: true });
  await rm(workspace, { recursive: true, force: true });
  const result: ProductBenchResult = {
    taskId: task.id,
    status: detail?.status ?? 'INCOMPLETE',
    passed: detail?.status === 'DONE',
    iterations: detail?.iterations ?? 0,
    tokens: detail?.usage.total.unknownCalls === 0 ? detail.usage.total.tokens : undefined,
    oraclePassed,
    oracleDetail: oracleRun.timedOut ? 'oracle timed out' : oracleRun.stderr || oracleRun.stdout,
    elapsedMs,
    attempts: detail?.usage.harness.calls ?? 0,
    hadRejectedAttempt: detail?.iterationsDetail.some((iteration) =>
      iteration.verdict?.pass === false || iteration.signoff?.veto === true) ?? false,
    ...(detail === undefined || run.timedOut || run.truncated
      ? { error: run.timedOut ? 'goaly outer timeout' : run.truncated ? 'goaly output cap' : 'no readable goaly run log' }
      : detail.reason !== undefined ? { error: detail.reason } : {}),
    ...(detail === undefined ? {} : { runId: detail.runId }),
    evidence: {
      workspace: savedWorkspace,
      runLogDir: detail === undefined ? null : join(savedWorkspace, '.goaly', detail.runId),
      oracleSha256,
      harness: 'codex', llmProvider: 'codex',
      model: model ?? 'Codex CLI default (not resolved by this evaluator)',
      degraded: detail?.degraded ?? null,
      ...(detail === undefined ? {} : { usage: detail.usage }),
    },
  };
  await writeFile(join(taskDir, 'result.json'), JSON.stringify({
    ...result, classification: classifyProductResult(result),
  }, null, 2));
  return result;
}

async function main(): Promise<void> {
  const selected = value('--task');
  const all = argv.includes('--all');
  if ((selected === undefined) === !all || argv.some((arg) => arg.startsWith('--') && !['--task', '--all', '--output', '--model'].includes(arg))) {
    throw new Error('usage: npx tsx scripts/eval-product.ts (--task order-pricing|event-report | --all) [--output DIR] [--model MODEL]');
  }
  const tasks = BENCH_TASKS.filter((task) => task.oracleId !== undefined && (all || task.id === selected));
  if (tasks.length === 0) throw new Error(`unknown product task: ${selected}`);
  const output = resolve(value('--output') ?? join(repo, 'evaluation', 'runs', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const results: ProductBenchResult[] = [];
  for (const task of tasks) {
    const result = await runTask(task, output, value('--model'));
    results.push(result);
    process.stdout.write(`${task.id}: ${classifyProductResult(result)} (${result.status}, oracle=${result.oraclePassed})\n`);
  }
  await writeFile(join(output, 'summary.json'), JSON.stringify({ results, metrics: summarizeProductBench(results) }, null, 2));
  process.stdout.write(`Evidence: ${output}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
