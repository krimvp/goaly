import type { RunDetail, IterationDetail } from '../runlog/inspect';
import type { CompiledContract, Rung } from '../domain/contract';

/**
 * Capability C — turn a finished run into a CONCISE, DETERMINISTIC seed for a follow-up goal.
 *
 * This is a pure projection `RunDetail → string` (no LLM, no IO, no new seam). The seed is woven
 * into the NEW run's compile-phase `feedback` — the same channel a Seal "revise" round uses — so the
 * follow-up's contract is authored AWARE of what just happened (prior goal, the frozen bar it met,
 * how it ended) without ever copying or weakening it: the new contract is still compiled, frozen, and
 * Sealed on its own (invariants #2/#3 untouched).
 *
 * It is deliberately a DIGEST, not a transcript dump — prior goal + the frozen contract's rubric and
 * a one-line-per-rung summary + the terminal status/reason + the final iteration's two-key outcome.
 * Bounded lengths keep it from leaking stale, over-specific detail into the new freeze.
 */

/** Cap individual free-text fields so a verbose prior run can't bloat the new authoring prompt. */
const MAX_RUBRIC = 600;
const MAX_DETAIL = 240;
const MAX_REASON = 300;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One-line summary of a frozen rung (the bar the prior run had to clear). */
function describeRung(rung: Rung): string {
  return rung.kind === 'deterministic'
    ? `[deterministic] ${clip(rung.command, MAX_DETAIL)}`
    : `[judge] quorum ${rung.quorum}, floor ${rung.confidenceFloor}`;
}

function describeContract(contract: CompiledContract): string[] {
  const lines = [`Prior frozen contract (hash ${contract.contractHash}):`];
  if (contract.rubric.trim().length > 0) {
    lines.push(`  rubric: ${clip(contract.rubric, MAX_RUBRIC)}`);
  }
  lines.push('  bar:');
  contract.rungs.forEach((rung, i) => lines.push(`    ${i + 1}. ${describeRung(rung)}`));
  return lines;
}

/** The two-key outcome of the run's final iteration (most informative for steering the follow-up). */
function describeFinalIteration(it: IterationDetail): string[] {
  const lines = [`Final iteration (#${it.index}): agent ${it.runStatus}, changed ${it.changed ? 'yes' : 'no'}`];
  if (it.verdict !== undefined) {
    const detail = it.verdict.detail.length > 0 ? ` — ${clip(it.verdict.detail, MAX_DETAIL)}` : '';
    lines.push(`  ladder: ${it.verdict.pass ? 'PASS' : 'FAIL'}${detail}`);
  }
  if (it.signoff !== undefined) {
    lines.push(
      `  sign-off: ${it.signoff.veto ? `VETO — ${clip(it.signoff.reason ?? '', MAX_DETAIL)}` : 'approved'}`,
    );
  }
  return lines;
}

/**
 * Build the follow-up seed from a prior run's {@link RunDetail}. Pure and deterministic: the same
 * detail always yields the same string (used directly in tests). Safe on a run with no contract or
 * no iterations (a compile-time failure) — it still summarizes what it can.
 */
export function compactRun(detail: RunDetail): string {
  const lines: string[] = [
    `# Prior run context (run ${detail.runId})`,
    'This goal continues from a previous goaly run in the SAME workspace, so that run\'s changes are',
    'already on disk. Use the summary below as context. Author FRESH verification for the new goal —',
    'do NOT copy, reuse, or weaken the prior frozen contract; it is shown only so you know what was',
    'already accomplished and how it was checked.',
    '',
    'Prior goal:',
    clip(detail.goal, MAX_RUBRIC),
    '',
    `Prior outcome: ${detail.status}${
      detail.reason !== undefined ? ` — ${clip(detail.reason, MAX_REASON)}` : ''
    } (${detail.iterations} iteration${detail.iterations === 1 ? '' : 's'})`,
  ];

  if (detail.contract !== null) {
    lines.push('', ...describeContract(detail.contract));
  }

  const finalIteration = detail.iterationsDetail[detail.iterationsDetail.length - 1];
  if (finalIteration !== undefined) {
    lines.push('', ...describeFinalIteration(finalIteration));
  }

  lines.push('', '# New goal (author and freeze its own contract)');
  return lines.join('\n');
}
