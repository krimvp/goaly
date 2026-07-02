import type { CompiledContract, Rung } from '../domain/contract';
import type { SealDecision } from '../domain/verdict';
import type { SealGate } from './seal';

const HUMAN_REJECT_REASON = 'rejected by human at Seal';

/** Render a rung as a single human-readable line for the contract banner. */
function describeRung(rung: Rung, index: number): string {
  if (rung.kind === 'deterministic') {
    const label = rung.label !== undefined ? ` (${rung.label})` : '';
    return `  [${index}] deterministic${label}: ${rung.command}`;
  }
  const label = rung.label !== undefined ? ` (${rung.label})` : '';
  return (
    `  [${index}] judge${label}: quorum=${rung.quorum} floor=${rung.confidenceFloor}\n` +
    `      rubric: ${rung.rubric}`
  );
}

/** Build the full, multi-line contract banner shared by both gates. */
function renderContract(contract: CompiledContract): string {
  const lines: string[] = [];
  lines.push('==================== SUCCESS CONTRACT ====================');
  lines.push(`goal: ${contract.goal}`);
  lines.push(`contractHash: ${contract.contractHash}`);
  if (contract.setup !== undefined) {
    lines.push(`setup (one-time, before iteration 1): ${contract.setup}`);
  }
  if (contract.requiredTools.length > 0) {
    lines.push(`requiredTools (must be on PATH; installed by the agent if missing): ${contract.requiredTools.join(', ')}`);
  }
  lines.push('rungs:');
  contract.rungs.forEach((rung, i) => {
    lines.push(describeRung(rung, i));
  });
  lines.push(`rubric: ${contract.rubric.length > 0 ? contract.rubric : '(none)'}`);
  if (contract.generatedFiles.length > 0) {
    lines.push(`generatedFiles: ${contract.generatedFiles.map((f) => f.path).join(', ')}`);
  }
  lines.push('==========================================================');
  return lines.join('\n');
}

/**
 * Seal in autonomous mode: auto-accept, but log the full frozen contract LOUDLY so the
 * skipped human pause is always auditable. Never skips the freeze — only the pause.
 */
export class AutoSealGate implements SealGate {
  readonly #log: (msg: string) => void;

  constructor(opts?: { log?: (msg: string) => void }) {
    this.#log = opts?.log ?? ((msg) => console.error(msg));
  }

  async approveContract(contract: CompiledContract): Promise<SealDecision> {
    this.#log(
      `AUTONOMOUS: auto-approving frozen success contract (Seal skipped).\n${renderContract(
        contract,
      )}`,
    );
    return { kind: 'approve' };
  }
}

/**
 * Seal in default mode: print the full contract and let a human approve, reject, revise, or
 * hand-edit it before the loop starts.
 *  - approve ('a'/'y'/'yes'): freeze stands, the loop starts.
 *  - revise  ('f'/'feedback'): collect a free-text note; the contract is re-authored with it
 *    and re-presented (bounded by maxSealRevisions in the reducer). Empty feedback can't
 *    steer a recompile, so it fails closed to reject.
 *  - edited  ('e'/'edited'): the operator changed the authored verification files in their OWN
 *    editor (ADR 0016) — goaly re-reads them from disk, re-freezes the contract (new hash), and
 *    re-presents it here. No LLM call; never consumes the revise cap, so it is offered even when
 *    revision rounds are capped at 0.
 *  - anything else: reject (abort).
 * When `allowRevise` is false (maxSealRevisions === 0) the prompt drops only the feedback path.
 */
export class HumanSealGate implements SealGate {
  readonly #ask: (question: string) => Promise<string>;
  readonly #out: (msg: string) => void;
  readonly #allowRevise: boolean;

  constructor(opts?: {
    ask?: (question: string) => Promise<string>;
    out?: (msg: string) => void;
    /** Offer the free-text revise path. Disable when revision rounds are capped at 0. */
    allowRevise?: boolean;
  }) {
    this.#out = opts?.out ?? ((msg) => console.error(msg));
    this.#ask = opts?.ask ?? defaultAsk;
    this.#allowRevise = opts?.allowRevise ?? true;
  }

  async approveContract(contract: CompiledContract): Promise<SealDecision> {
    this.#out(renderContract(contract));
    if (!this.#allowRevise) {
      const answer = await this.#ask(
        'Approve this success contract? [y]es / [e]dited (I changed the authored files — re-freeze) / [N]o ',
      );
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'e' || normalized === 'edited') return { kind: 'edited' };
      return approveOrReject(answer);
    }
    const answer = await this.#ask(
      'Approve, revise with feedback, re-freeze your manual edits, or reject? ' +
        '[a]pprove / [f]eedback / [e]dited / [r]eject: ',
    );
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'f' || normalized === 'feedback' || normalized === 'revise') {
      const feedback = (await this.#ask('Describe what to change in the contract: ')).trim();
      if (feedback.length === 0) {
        return { kind: 'reject', reason: HUMAN_REJECT_REASON };
      }
      return { kind: 'revise', feedback };
    }
    if (normalized === 'e' || normalized === 'edited') {
      return { kind: 'edited' };
    }
    return approveOrReject(answer);
  }
}

/** Map a yes/approve answer to approve; everything else (incl. empty) to reject. */
function approveOrReject(answer: string): SealDecision {
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'y' || normalized === 'yes' || normalized === 'a' || normalized === 'approve') {
    return { kind: 'approve' };
  }
  return { kind: 'reject', reason: HUMAN_REJECT_REASON };
}

/** Default prompt: a single question over stdin/stdout via readline/promises. */
async function defaultAsk(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
