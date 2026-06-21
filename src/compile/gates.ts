import type { CompiledContract, Rung } from '../domain/contract';
import type { GateDecision } from '../domain/verdict';
import type { ContractGate } from './gateA';

const HUMAN_REJECT_REASON = 'rejected by human at Gate A';

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
  lines.push('rungs:');
  contract.rungs.forEach((rung, i) => {
    lines.push(describeRung(rung, i));
  });
  lines.push(`rubric: ${contract.rubric.length > 0 ? contract.rubric : '(none)'}`);
  if (contract.generatedFiles.length > 0) {
    lines.push(`generatedFiles: ${contract.generatedFiles.join(', ')}`);
  }
  lines.push('==========================================================');
  return lines.join('\n');
}

/**
 * Gate A in autonomous mode: auto-accept, but log the full frozen contract LOUDLY so the
 * skipped human pause is always auditable. Never skips the freeze — only the pause.
 */
export class AutoContractGate implements ContractGate {
  readonly #log: (msg: string) => void;

  constructor(opts?: { log?: (msg: string) => void }) {
    this.#log = opts?.log ?? ((msg) => console.error(msg));
  }

  async approveContract(contract: CompiledContract): Promise<GateDecision> {
    this.#log(
      `AUTONOMOUS: auto-approving frozen success contract (Gate A skipped).\n${renderContract(
        contract,
      )}`,
    );
    return { approved: true };
  }
}

/**
 * Gate A in default mode: print the full contract and ask a human to approve it once
 * before the loop starts. Approves only on an explicit 'y'/'yes'; anything else rejects.
 */
export class HumanContractGate implements ContractGate {
  readonly #ask: (question: string) => Promise<string>;
  readonly #out: (msg: string) => void;

  constructor(opts?: {
    ask?: (question: string) => Promise<string>;
    out?: (msg: string) => void;
  }) {
    this.#out = opts?.out ?? ((msg) => console.error(msg));
    this.#ask = opts?.ask ?? defaultAsk;
  }

  async approveContract(contract: CompiledContract): Promise<GateDecision> {
    this.#out(renderContract(contract));
    const answer = await this.#ask('Approve this success contract? [y/N] ');
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'y' || normalized === 'yes') {
      return { approved: true };
    }
    return { approved: false, reason: HUMAN_REJECT_REASON };
  }
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
