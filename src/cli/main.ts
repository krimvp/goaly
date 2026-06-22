import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs, USAGE, UsageError, type ParsedArgs } from './args';
import { composeDeps, STATE_DIR } from './compose';
import { runRuns } from './runs';
import { drive } from '../driver/driver';
import { asRunId, type RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';
import { resolveModels } from './models';
import { parsePriceTable, computeCost, type CostView, type PriceTable } from './cost';
import { formatUsage } from './usage-format';

/** The model/provider flags the user actually set, as structured log fields (set ones only). */
function startupFields(parsed: ParsedArgs): Record<string, string> {
  const m = parsed.models;
  const fields: Record<string, string> = {};
  if (m.model !== undefined) fields.model = m.model;
  if (m.llmModel !== undefined) fields.llmModel = m.llmModel;
  if (m.judgeModel !== undefined) fields.judgeModel = m.judgeModel;
  if (m.approverModel !== undefined) fields.approverModel = m.approverModel;
  if (m.compilerModel !== undefined) fields.compilerModel = m.compilerModel;
  if (parsed.llmProvider !== 'claude') fields.llmProvider = parsed.llmProvider;
  return fields;
}

/**
 * CLI entry. Returns a process exit code (0 = DONE, 1 = FAILED/ABORTED, 2 = usage error) so the
 * thin bin launcher stays trivial and `main` is unit-testable.
 */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = await parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }

  if (parsed.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (parsed.command === 'runs' && parsed.runs !== undefined) {
    const stateDir = path.join(parsed.workspace, STATE_DIR);
    return runRuns(
      parsed.runs,
      stateDir,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }

  // Load the optional cost table BEFORE the run so a malformed table fails fast (never mid-run).
  let priceTable: PriceTable | undefined;
  if (parsed.costTablePath !== undefined) {
    try {
      priceTable = parsePriceTable(await readFile(parsed.costTablePath, 'utf8'));
    } catch (e) {
      process.stderr.write(
        `--cost-table ${parsed.costTablePath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  }

  const resuming = parsed.resumeRunId !== undefined;
  const runId: RunId =
    parsed.resumeRunId !== undefined ? asRunId(parsed.resumeRunId) : asRunId(`run-${randomUUID()}`);
  const deps = composeDeps(parsed.config, {
    harness: parsed.harness,
    models: parsed.models,
    llmProvider: parsed.llmProvider,
    workspaceRoot: parsed.workspace,
    runId,
    logLevel: parsed.logLevel,
    timeouts: parsed.timeouts,
    ...(parsed.logFile !== undefined ? { logFile: parsed.logFile } : {}),
    ...(parsed.noLogFile ? { noLogFile: true } : {}),
    ...(parsed.stream ? { stream: true } : {}),
    ...(parsed.streamTranscript ? { streamTranscript: true } : {}),
    ...(parsed.streamFile !== undefined ? { streamFile: parsed.streamFile } : {}),
  });

  // Human-facing startup banner, routed through the logger so it respects --log-level and lands
  // in the diagnostics file too. The run outcome below stays on stdout (the machine-facing result).
  deps.logger?.info('cli starting', {
    harness: parsed.harness,
    autonomous: parsed.config.autonomous,
    ...(parsed.configSources.length > 0 ? { configFile: parsed.configSources.join(', ') } : {}),
    ...startupFields(parsed),
  });

  const outcome = await drive(deps, parsed.config, runId, { resume: resuming });
  const cost =
    priceTable !== undefined && outcome.usage !== undefined
      ? computeCost(outcome.usage, resolveModels(parsed.models), priceTable)
      : undefined;
  process.stdout.write(`${formatOutcome(outcome, cost)}\n`);
  return outcome.status === 'DONE' ? 0 : 1;
}

export function formatOutcome(o: RunOutcome, cost?: CostView): string {
  const lines = [
    '',
    `── goaly run ${o.runId} ──`,
    `status:      ${o.status}`,
    `iterations:  ${o.iterations}`,
    `contract:    ${o.contractHash ?? '(none — failed before compile)'}`,
  ];
  if (o.reason !== undefined) lines.push(`reason:      ${o.reason}`);
  if (o.usage !== undefined) lines.push(...formatUsage(o.usage, cost));
  return lines.join('\n');
}
