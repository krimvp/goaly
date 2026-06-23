import type { PhasePlan } from '../domain/plan';
import type { SealDecision } from '../domain/verdict';
import type { PlanGate } from './plan-gate';

const HUMAN_REJECT_REASON = 'plan rejected by human at the plan Seal';

/** Build the full, multi-line plan banner shared by both gates. */
function renderPlan(plan: PhasePlan): string {
  const lines: string[] = [];
  lines.push('==================== DECOMPOSITION PLAN ===================');
  lines.push(`planHash: ${plan.planHash}`);
  lines.push(`phases: ${plan.phases.length} (+ 1 cumulative acceptance on the original goal)`);
  plan.phases.forEach((p, i) => {
    lines.push(`  [${i + 1}] ${p.goal}`);
    if (p.intent !== undefined) lines.push(`      intent: ${p.intent}`);
    if (p.rubric !== undefined) lines.push(`      rubric: ${p.rubric}`);
  });
  lines.push('==========================================================');
  return lines.join('\n');
}

/**
 * The plan Seal in autonomous mode: auto-accept, but log the full frozen plan LOUDLY so the skipped
 * human pause is always auditable. Never skips the freeze — only the pause (invariant #5).
 */
export class AutoPlanGate implements PlanGate {
  readonly #log: (msg: string) => void;

  constructor(opts?: { log?: (msg: string) => void }) {
    this.#log = opts?.log ?? ((msg) => console.error(msg));
  }

  async approvePlan(plan: PhasePlan): Promise<SealDecision> {
    this.#log(`AUTONOMOUS: auto-approving frozen decomposition plan (plan Seal skipped).\n${renderPlan(plan)}`);
    return { kind: 'approve' };
  }
}

/**
 * The plan Seal in default mode: print the full plan and let a human approve, reject, or revise it
 * before the phase loop starts (mirrors {@link HumanSealGate}).
 *  - approve ('a'/'y'/'yes'): the freeze stands, the phase loop starts.
 *  - revise  ('f'/'feedback'): collect a free-text note; the plan is re-authored with it and
 *    re-presented (bounded by maxPlanRevisions in the reducer). Empty feedback fails closed to reject.
 *  - anything else: reject (abort).
 * When `allowRevise` is false (maxPlanRevisions === 0) the prompt is the plain binary [y/N].
 */
export class HumanPlanGate implements PlanGate {
  readonly #ask: (question: string) => Promise<string>;
  readonly #out: (msg: string) => void;
  readonly #allowRevise: boolean;

  constructor(opts?: {
    ask?: (question: string) => Promise<string>;
    out?: (msg: string) => void;
    allowRevise?: boolean;
  }) {
    this.#out = opts?.out ?? ((msg) => console.error(msg));
    this.#ask = opts?.ask ?? defaultAsk;
    this.#allowRevise = opts?.allowRevise ?? true;
  }

  async approvePlan(plan: PhasePlan): Promise<SealDecision> {
    this.#out(renderPlan(plan));
    if (!this.#allowRevise) {
      return approveOrReject(await this.#ask('Approve this decomposition plan? [y/N] '));
    }
    const answer = await this.#ask(
      'Approve, revise with feedback, or reject? [a]pprove / [f]eedback / [r]eject: ',
    );
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'f' || normalized === 'feedback' || normalized === 'revise') {
      const feedback = (await this.#ask('Describe what to change in the plan: ')).trim();
      if (feedback.length === 0) return { kind: 'reject', reason: HUMAN_REJECT_REASON };
      return { kind: 'revise', feedback };
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
