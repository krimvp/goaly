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
    case 'WAVE_RAN': {
      const merged = e.outcomes.filter((o) => o.kind === 'merged').length;
      const fallback = e.outcomes.length - merged;
      const text = `wave: ${merged}/${e.outcomes.length} phase(s) merged + re-verified${fallback > 0 ? `, ${fallback} downgraded to sequential` : ''}`;
      return { at, text, tone: fallback > 0 ? 'plain' : 'pass' };
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

/** Compact token counts for stat tiles: 950 → "950", 12_345 → "12.3k", 4_200_000 → "4.2M". */
export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimmed(n / 1000)}k`;
  return `${trimmed(n / 1_000_000)}M`;
}

function trimmed(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Human duration between two epoch-ms stamps: "42s", "3m 12s", "2h 05m". */
export function fmtDuration(fromMs: number, toMs: number): string {
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Coarse relative time for the run board: "just now", "5m ago", "3h ago", "2d ago". */
export function fmtAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The mission pipeline the run detail header draws: the fixed COMPILE → SEAL → PREP journey into
 * the AGENT → VERIFY → SIGN-OFF loop, ending at DONE. Each orchestrator state tag maps onto one
 * stage so the strip can highlight where the run is right now.
 */
export const PIPELINE_STAGES = [
  { key: 'plan', label: 'plan' },
  { key: 'compile', label: 'compile' },
  { key: 'seal', label: 'seal' },
  { key: 'prepare', label: 'prep' },
  { key: 'agent', label: 'agent' },
  { key: 'verify', label: 'verify' },
  { key: 'signoff', label: 'sign-off' },
  { key: 'done', label: 'done' },
] as const;
export type PipelineStageKey = (typeof PIPELINE_STAGES)[number]['key'];

/** Which pipeline stage a state tag sits at — null for terminal failure (the strip dims instead). */
export function pipelineStageOf(stateTag: string): PipelineStageKey | null {
  switch (stateTag) {
    case 'PLANNING':
    case 'AWAIT_PLAN_SEAL':
      return 'plan';
    case 'COMPILING':
      return 'compile';
    case 'AWAIT_SEAL':
      return 'seal';
    case 'PREPARING':
      return 'prepare';
    case 'RUNNING_AGENT':
    case 'RUNNING_WAVE':
    case 'ADVANCING_PHASE':
      return 'agent';
    case 'VERIFYING':
      return 'verify';
    case 'AWAIT_SIGNOFF':
      return 'signoff';
    case 'DONE':
      return 'done';
    default:
      return null; // FAILED / ABORTED / unknown-future tags: no active stage
  }
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
