import type { CompiledContract, Rung } from '../domain/contract';
import type { SealDecision } from '../domain/verdict';
import type { SealGate } from './seal';

const HUMAN_REJECT_REASON = 'rejected by human at Seal';

/** Pointer used when a judge rung's rubric is byte-identical to the contract rubric printed above. */
const SAME_RUBRIC = '(same as the contract rubric above)';

/**
 * Render a rung as a human-readable block for the contract banner. `contractRubric` is the
 * top-level rubric already printed above: a judge rung whose rubric is identical points at it
 * instead of repeating it (issue #120 — the rubric is the largest block of the banner, and
 * printing it twice pushed the command/setup/files an operator needs off screen). A rung-specific
 * rubric — the schema allows one — is still spelled out in full.
 */
function describeRung(rung: Rung, index: number, contractRubric: string): string {
  const label = rung.label !== undefined ? ` (${rung.label})` : '';
  if (rung.kind === 'deterministic') {
    return `  [${index}] deterministic${label}: ${rung.command}`;
  }
  const rubric = rung.rubric === contractRubric ? SAME_RUBRIC : rung.rubric;
  return (
    `  [${index}] judge${label}: quorum=${rung.quorum} floor=${rung.confidenceFloor}\n` +
    `      rubric: ${rubric}`
  );
}

/**
 * Render the generated-files integrity guard the ladder prepends when the contract pins authored
 * verification files (`buildLadder`, `src/cli/compose.ts`). It is a real rung that can red the
 * ladder, so it is shown here — otherwise the printed count undercounts the `rungsTotal` every
 * verdict reports (issue #120).
 */
function describeGuardRung(fileCount: number, index: number): string {
  return `  [${index}] guard (built-in, not part of contractHash): generated-files integrity — ${fileCount} authored file(s) must match their frozen hash`;
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
  // The rubric is printed ONCE, before the ladder, so judge rungs can point back at it.
  lines.push(`rubric: ${contract.rubric.length > 0 ? contract.rubric : '(none)'}`);
  lines.push('rungs:');
  const guarded = contract.generatedFiles.length > 0;
  if (guarded) lines.push(describeGuardRung(contract.generatedFiles.length, 0));
  const offset = guarded ? 1 : 0;
  contract.rungs.forEach((rung, i) => {
    lines.push(describeRung(rung, i + offset, contract.rubric));
  });
  if (guarded) {
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
