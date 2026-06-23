import type { RunsCommand } from './args';
import type { CompiledContract, Rung } from '../domain/contract';
import type { SealDecision } from '../domain/verdict';
import {
  listRuns,
  readRun,
  type IterationDetail,
  type RunDetail,
  type RunListItem,
  type RunSummary,
} from '../runlog/inspect';
import { formatUsage } from './usage-format';

/**
 * Render the read-only `goaly runs` subcommands (issue #14). A pure presentation layer over the
 * inspection projections: it performs no mutation and writes results through injected `out`/`err`
 * sinks (no `console.log` in library code). Returns the process exit code.
 */
export async function runRuns(
  cmd: RunsCommand,
  stateDir: string,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  if (cmd.kind === 'list') return runsList(stateDir, out);
  return runsShow(cmd.runId, stateDir, out, err);
}

async function runsList(stateDir: string, out: (s: string) => void): Promise<number> {
  const items = await listRuns(stateDir);
  if (items.length === 0) {
    out(`No runs found in ${stateDir}\n`);
    return 0;
  }
  out(`${renderRunsTable(items)}\n`);
  return 0;
}

async function runsShow(
  runId: string,
  stateDir: string,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const result = await readRun(stateDir, runId);
  if (result === null) {
    err(`no such run: ${runId} (looked in ${stateDir})\n`);
    return 1;
  }
  if (!result.ok) {
    err(`run ${runId} is corrupt: ${result.error}\n`);
    return 1;
  }
  out(`${renderRunDetail(result.detail)}\n`);
  return 0;
}

// ---- list rendering -------------------------------------------------------

const GOAL_WIDTH = 50;

export function renderRunsTable(items: readonly RunListItem[]): string {
  const headers = ['RUN ID', 'STATUS', 'ITERS', 'TOKENS', 'STARTED', 'ENDED', 'GOAL'];
  const rows = items.map((item) => (item.ok ? summaryRow(item.summary) : corruptRow(item)));
  return renderTable(headers, rows);
}

function summaryRow(s: RunSummary): string[] {
  return [
    s.runId,
    s.status,
    String(s.iterations),
    s.tokensSpent === undefined ? '-' : String(s.tokensSpent),
    fmtTime(s.startedAt),
    s.endedAt === undefined ? '-' : fmtTime(s.endedAt),
    truncate(s.goal, GOAL_WIDTH),
  ];
}

function corruptRow(item: Extract<RunListItem, { ok: false }>): string[] {
  return [item.runId, 'CORRUPT', '-', '-', '-', '-', truncate(item.error, GOAL_WIDTH)];
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const pad = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [pad(headers), ...rows.map(pad)].join('\n');
}

// ---- show rendering -------------------------------------------------------

export function renderRunDetail(d: RunDetail): string {
  const lines: string[] = [
    '',
    `── goaly run ${d.runId} ──`,
    `status:      ${d.status}${d.status === 'INCOMPLETE' ? ` (${d.stateTag})` : ''}`,
    `goal:        ${d.goal}`,
    `started:     ${fmtTime(d.startedAt)}`,
    `ended:       ${d.endedAt === undefined ? '-' : fmtTime(d.endedAt)}`,
    `iterations:  ${d.iterations}`,
    `tokens:      ${d.tokensSpent === undefined ? '-' : d.tokensSpent}`,
  ];
  if (d.reason !== undefined) lines.push(`reason:      ${d.reason}`);
  lines.push(...renderContract(d.contract));
  lines.push(...renderSeal(d.seal, d.compileFailures));
  lines.push(...renderPrepare(d.prepare));
  lines.push(...renderIterations(d.iterationsDetail));
  // The per-layer spend breakdown (issue #17), folded from the same log — tokens-only here, since
  // cost pricing is a volatile print-time overlay applied only to a live run's `--cost-table`.
  lines.push('', ...formatUsage(d.usage));
  return lines.join('\n');
}

function renderContract(contract: CompiledContract | null): string[] {
  if (contract === null) return ['', 'contract:    (none — run failed before compile)'];
  const lines = ['', `contract:    ${contract.contractHash}`, `  rubric:    ${contract.rubric}`];
  if (contract.setup !== undefined) {
    lines.push(`  setup:     ${contract.setup}  (one-time, before iteration 1)`);
  }
  if (contract.generatedFiles.length > 0) {
    lines.push(`  generated: ${contract.generatedFiles.map((f) => f.path).join(', ')}`);
  }
  lines.push('  rungs:');
  contract.rungs.forEach((rung, i) => lines.push(`    ${i + 1}. ${fmtRung(rung)}`));
  return lines;
}

function fmtRung(rung: Rung): string {
  const label = rung.label !== undefined ? `  (${rung.label})` : '';
  return rung.kind === 'deterministic'
    ? `[deterministic] ${rung.command}${label}`
    : `[judge] quorum ${rung.quorum}, floor ${rung.confidenceFloor}${label}`;
}

function renderSeal(seal: readonly SealDecision[], compileFailures: readonly string[]): string[] {
  const lines: string[] = [''];
  for (const reason of compileFailures) lines.push(`compile:     FAILED — ${reason}`);
  if (seal.length === 0) {
    lines.push('seal:        (not reached)');
    return lines;
  }
  lines.push(`seal:        ${seal.map(fmtSealDecision).join(' → ')}`);
  return lines;
}

function fmtSealDecision(d: SealDecision): string {
  switch (d.kind) {
    case 'approve':
      return 'approve';
    case 'reject':
      return `reject (${d.reason})`;
    case 'revise':
      return 'revise';
  }
}

/** Render the one-time prepare phase (Fix #1 setup + Fix #2 pre-flight) when it ran. */
function renderPrepare(prepare: RunDetail['prepare']): string[] {
  if (prepare === undefined) return [];
  const setup = prepare.setupRan ? 'setup ran' : 'no setup';
  return ['', `prepare:     ${prepare.status} (${setup})`];
}

function renderIterations(iterations: readonly IterationDetail[]): string[] {
  if (iterations.length === 0) return ['', 'iterations:  (none ran)'];
  const lines = ['', 'iterations:'];
  for (const it of iterations) {
    lines.push(`  #${it.index}  agent=${it.runStatus}  changed=${it.changed ? 'yes' : 'no'}${
      it.tokensSpent === undefined ? '' : `  tokens=${it.tokensSpent}`
    }`);
    lines.push(`      ladder=${fmtVerdict(it)}`);
    if (it.signoff !== undefined) {
      lines.push(`      sign-off=${it.signoff.veto ? `VETO (${it.signoff.reason ?? ''})` : 'approved'}`);
    }
  }
  return lines;
}

function fmtVerdict(it: IterationDetail): string {
  if (it.verdict === undefined) return '(not reached)';
  const v = it.verdict;
  return `${v.pass ? 'PASS' : 'FAIL'} (confidence ${v.confidence})${v.detail ? ` — ${v.detail}` : ''}`;
}

// ---- shared helpers -------------------------------------------------------

/** Epoch-ms → a compact, timezone-stable `YYYY-MM-DD HH:MM:SS` (UTC) for deterministic output. */
function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
