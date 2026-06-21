import { randomUUID } from 'node:crypto';
import { parseArgs, USAGE, UsageError, type ParsedArgs } from './args';
import { composeDeps } from './compose';
import { drive } from '../driver/driver';
import { asRunId, type RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';

/** Append the model/provider flags to the startup log, but only the ones the user actually set. */
function formatModelNote(parsed: ParsedArgs): string {
  const m = parsed.models;
  const parts: string[] = [];
  if (m.model !== undefined) parts.push(`model=${m.model}`);
  if (m.llmModel !== undefined) parts.push(`llm-model=${m.llmModel}`);
  if (m.judgeModel !== undefined) parts.push(`judge-model=${m.judgeModel}`);
  if (m.approverModel !== undefined) parts.push(`approver-model=${m.approverModel}`);
  if (m.compilerModel !== undefined) parts.push(`compiler-model=${m.compilerModel}`);
  if (parsed.llmProvider !== 'claude') parts.push(`llm-provider=${parsed.llmProvider}`);
  return parts.length > 0 ? `, ${parts.join(', ')}` : '';
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

  const resuming = parsed.resumeRunId !== undefined;
  const runId: RunId =
    parsed.resumeRunId !== undefined ? asRunId(parsed.resumeRunId) : asRunId(`run-${randomUUID()}`);
  const deps = composeDeps(parsed.config, {
    harness: parsed.harness,
    models: parsed.models,
    llmProvider: parsed.llmProvider,
    workspaceRoot: parsed.workspace,
    runId,
  });

  process.stderr.write(
    `goaly: ${resuming ? 'resuming' : 'starting'} ${runId} ` +
      `(harness=${parsed.harness}${formatModelNote(parsed)}, ` +
      `autonomous=${parsed.config.autonomous})\n`,
  );

  const outcome = await drive(deps, parsed.config, runId, { resume: resuming });
  process.stdout.write(`${formatOutcome(outcome)}\n`);
  return outcome.status === 'DONE' ? 0 : 1;
}

export function formatOutcome(o: RunOutcome): string {
  const lines = [
    '',
    `── goaly run ${o.runId} ──`,
    `status:      ${o.status}`,
    `iterations:  ${o.iterations}`,
    `contract:    ${o.contractHash ?? '(none — failed before compile)'}`,
  ];
  if (o.reason !== undefined) lines.push(`reason:      ${o.reason}`);
  return lines.join('\n');
}
