import type { RunLogEntry } from '../../runlog/runlog';
import type { StreamTranscriptEntry } from '../../runlog/stream-transcript';
import type { CompiledContract } from '../../domain/contract';
import type { SealEditPatch } from '../../domain/verdict';

/**
 * Pure presentation helpers for the browser (no DOM, no node imports — unit-testable in vitest).
 * The event wording mirrors `renderWatchEvent` (src/cli/watch.ts) so the web feed and
 * `goaly runs watch` tell the same story; that renderer stays node-side (it lives with the CLI),
 * this one is the browser twin over the same `RunLogEntry` type.
 */

export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export type FeedLine = { at: string; text: string; tone: 'plain' | 'pass' | 'fail' };

/** One run-log entry → one feed line (or null for plumbing markers a human doesn't need). */
export function feedLine(entry: RunLogEntry, iteration: number): FeedLine | null {
  const at = fmtTime(entry.ts);
  const e = entry.event;
  const plain = (text: string): FeedLine => ({ at, text, tone: 'plain' });
  switch (e.tag) {
    case 'PLAN_COMPILED':
      return plain(`plan compiled: ${e.plan.phases.length} phases + acceptance (${e.plan.planHash})`);
    case 'PLAN_FAILED':
      return { at, text: `plan FAILED: ${truncate(e.reason, 160)}`, tone: 'fail' };
    case 'PLAN_SEAL_DECIDED':
      return plain(`plan seal: ${e.decision.kind}`);
    case 'PHASE_ADVANCED':
      return plain('phase advanced (checkpoint taken)');
    case 'CONTRACT_COMPILED':
      return plain(`contract compiled: ${e.contract.rungs.length} rung(s), frozen as ${e.contract.contractHash}`);
    case 'COMPILE_FAILED':
      return { at, text: `compile FAILED: ${truncate(e.reason, 160)}`, tone: 'fail' };
    case 'SEAL_DECIDED':
      return plain(`seal: ${e.decision.kind}${e.decision.kind === 'reject' ? ` — ${truncate(e.decision.reason, 100)}` : ''}`);
    case 'WORKSPACE_PREPARED':
      return plain(`prepare: ${e.prepared.status}${e.setupRan ? ' (setup ran)' : ''}`);
    case 'AGENT_RAN': {
      const changed = e.prevDiffHash !== e.diffHash ? 'tree changed' : 'no changes';
      const tokens = e.run.tokensUsed !== undefined ? `, ${e.run.tokensUsed} tokens` : '';
      return plain(`iter ${iteration}: agent ${e.run.status} (${changed}${tokens})`);
    }
    case 'VERIFIED':
      return e.verdict.pass
        ? { at, text: `iter ${iteration}: verify PASS ✓`, tone: 'pass' }
        : { at, text: `iter ${iteration}: verify FAIL ✗ — ${truncate(e.verdict.detail, 160)}`, tone: 'fail' };
    case 'SIGNOFF_DECIDED':
      return e.approval.veto
        ? { at, text: `iter ${iteration}: sign-off VETO — ${truncate(e.approval.reason ?? '', 160)}`, tone: 'fail' }
        : { at, text: `iter ${iteration}: sign-off approved (both keys turned)`, tone: 'pass' };
    case 'CANDIDATE_RAN':
      return plain(`iter ${e.iteration}: candidate #${e.index} ${e.pass ? 'passed' : 'failed'} the ladder`);
    case 'CANDIDATE_SELECTED':
      return plain(`iter ${e.iteration}: candidate #${e.winner} selected`);
    case 'RUN_EXTENDED': {
      const parts = [
        ...(e.maxIterations !== undefined ? [`max-iterations→${e.maxIterations}`] : []),
        ...(e.budgetTokens !== undefined ? [`budget-tokens→${e.budgetTokens}`] : []),
        ...(e.budgetWallMs !== undefined ? [`budget-wall-ms→${e.budgetWallMs}`] : []),
        ...(e.stuck !== undefined ? ['stuck-policy overrides'] : []),
        ...(e.note !== undefined ? [`note: "${truncate(e.note, 80)}"`] : []),
      ];
      return plain(`operator extension: ${parts.join(', ')}`);
    }
    case 'CHECKPOINTED':
      return null; // internal diff-baseline plumbing — noise for a human
  }
}

/** One per-turn stream-transcript entry → a compact feed line (tool uses, messages, usage). */
export function streamLine(entry: StreamTranscriptEntry): FeedLine | null {
  const at = fmtTime(entry.ts);
  const tag = `[${entry.phase}]`;
  const plain = (text: string): FeedLine => ({ at, text: `${tag} ${text}`, tone: 'plain' });
  switch (entry.kind) {
    case 'session':
      return plain(`session ${entry.sessionId}`);
    case 'message':
      return entry.text.trim().length === 0 ? null : plain(truncate(entry.text, 240));
    case 'reasoning':
      return entry.text.trim().length === 0 ? null : plain(`(thinking) ${truncate(entry.text, 160)}`);
    case 'tool_use':
      return plain(`⚒ ${entry.name}${entry.input !== undefined ? ` ${truncate(JSON.stringify(entry.input), 140)}` : ''}`);
    case 'tool_result':
      return entry.isError === true
        ? { at, text: `${tag} ✗ ${truncate(entry.output, 180)}`, tone: 'fail' }
        : plain(`→ ${truncate(entry.output, 180)}`);
    case 'usage':
      return entry.totalTokens !== undefined ? plain(`${entry.totalTokens} tokens`) : null;
    case 'done':
      return plain(`turn done (${entry.status})`);
  }
}

/** Count AGENT_RAN entries up to and including index i — the iteration number feedLine needs. */
export function iterationAt(entries: readonly RunLogEntry[], index: number): number {
  let n = 0;
  for (let i = 0; i <= index && i < entries.length; i++) {
    if (entries[i]?.event.tag === 'AGENT_RAN') n += 1;
  }
  return n;
}

export function statusBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'done') return 'badge done';
  if (s === 'failed' || s === 'aborted' || s === 'corrupt') return `badge ${s}`;
  return 'badge incomplete';
}

/** The review station's editable contract FIELDS, as the modal's form state (ADR 0016). */
export type SealFieldEdits = {
  /** '' means "cleared" (→ `setup: null` in the patch). */
  setup: string;
  rubric: string;
  /** One entry per rung index; judge rungs keep '' and are never patched. */
  commands: string[];
};

/** The modal's initial form state, prefilled from the parked contract. */
export function sealFieldsOf(contract: CompiledContract): SealFieldEdits {
  return {
    setup: contract.setup ?? '',
    rubric: contract.rubric,
    commands: contract.rungs.map((r) => (r.kind === 'deterministic' ? r.command : '')),
  };
}

/**
 * Diff the edited form state against the parked contract into a minimal {@link SealEditPatch} —
 * or undefined when nothing changed (the refreeze then just re-pins the files from disk). Pure,
 * so it is testable without preact; judge-rung entries are ignored by construction.
 */
export function buildSealPatch(
  contract: CompiledContract,
  edited: SealFieldEdits,
): SealEditPatch | undefined {
  const patch: SealEditPatch = {};
  const trimmedSetup = edited.setup.trim();
  if (trimmedSetup !== (contract.setup ?? '')) {
    patch.setup = trimmedSetup === '' ? null : trimmedSetup;
  }
  if (edited.rubric !== contract.rubric) patch.rubric = edited.rubric;
  const commands: Array<{ index: number; command: string }> = [];
  contract.rungs.forEach((rung, index) => {
    if (rung.kind !== 'deterministic') return;
    const command = (edited.commands[index] ?? '').trim();
    if (command !== '' && command !== rung.command) commands.push({ index, command });
  });
  if (commands.length > 0) patch.commands = commands;
  return Object.keys(patch).length > 0 ? patch : undefined;
}
