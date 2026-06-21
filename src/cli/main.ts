import { randomUUID } from 'node:crypto';
import { parseArgs, USAGE, UsageError } from './args';
import { composeDeps } from './compose';
import { drive } from '../driver/driver';
import { asRunId, type RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';

/**
 * CLI entry. Returns a process exit code (0 = DONE, 1 = FAILED/ABORTED, 2 = usage error) so the
 * thin bin launcher stays trivial and `main` is unit-testable.
 */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
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
    workspaceRoot: parsed.workspace,
    runId,
  });

  process.stderr.write(
    `goalorch: ${resuming ? 'resuming' : 'starting'} ${runId} ` +
      `(harness=${parsed.harness}, autonomous=${parsed.config.autonomous})\n`,
  );

  const outcome = await drive(deps, parsed.config, runId, { resume: resuming });
  process.stdout.write(`${formatOutcome(outcome)}\n`);
  return outcome.status === 'DONE' ? 0 : 1;
}

export function formatOutcome(o: RunOutcome): string {
  const lines = [
    '',
    `── goalorch run ${o.runId} ──`,
    `status:      ${o.status}`,
    `iterations:  ${o.iterations}`,
    `contract:    ${o.contractHash ?? '(none — failed before compile)'}`,
  ];
  if (o.reason !== undefined) lines.push(`reason:      ${o.reason}`);
  return lines.join('\n');
}
