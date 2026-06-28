import type { OrchestratorEvent, RunOutcome } from '../domain/events';
import type { CompiledContract, Rung } from '../domain/contract';
import type { Verdict, ApprovalVerdict } from '../domain/verdict';
import type { LlmProvider, LlmRequest } from '../llm/provider';

/**
 * The `--explain` observer (issue #8): an OPTIONAL, strictly read-only side-LLM that narrates a run
 * in plain language at three checkpoints — the frozen contract at Seal, each verifier-ladder run,
 * and the terminal outcome (especially a stuck stop). It is an EXPLAINER, never a decision-maker:
 * it reuses the internal {@link LlmProvider} seam read-only, it is fed the SAME lifecycle events the
 * Driver already sees, and it can NEVER influence the frozen contract, the verifier ladder, DECIDE,
 * or the two-key DONE (invariants #2/#3). Its output is advisory text only — written to a sink,
 * never to the replay log, so resume stays a fold over `OrchestratorEvent`.
 *
 * Fail-closed everywhere (invariant #4): a provider error, a malformed completion, or a throwing
 * writer all degrade to "no summary" — they can never crash a run, change its outcome, or alter a
 * verdict. The Driver additionally guards every call, so even a programming error here is contained.
 */
export interface Observer {
  /** Narrate a lifecycle event at a checkpoint, if it is one we explain. Never throws. */
  onEvent(event: OrchestratorEvent): Promise<void>;
  /** Narrate the terminal outcome (DONE / FAILED / ABORTED-stuck). Never throws. */
  onOutcome(outcome: RunOutcome): Promise<void>;
}

/**
 * Where the observer writes its plain-language summaries. Injected (never a bare `console.log`) so
 * it stays library-pure and testable; the composition root binds it to stderr, alongside — but
 * independent of — the `--stream` live view.
 */
export type ObserverWriter = (text: string) => void;

/** Hard cap on a single summary so a rambling completion can never flood the terminal. */
const MAX_SUMMARY_CHARS = 800;

/**
 * Loose, lower-cased markers the stuck detector stamps into an ABORTED reason (see
 * `orchestrator/stuck.ts`): the typed `STUCK_*` labels plus the human-facing kind prefixes that
 * don't carry one. Used ONLY to add an advisory "this was a stuck stop" hint to the outcome prompt
 * — a miss merely drops the hint, never anything load-bearing — so a loose match is the right tool.
 */
const STUCK_MARKERS = ['stuck_', 'no-diff', 'oscillation', 'repeat-failure', 'budget exceeded'] as const;

function looksStuck(reason: string | undefined): boolean {
  if (reason === undefined) return false;
  const lower = reason.toLowerCase();
  return STUCK_MARKERS.some((m) => lower.includes(m));
}

const SYSTEM_PROMPT =
  'You are a neutral run narrator for goaly, a tool that runs a coding agent in a loop until a ' +
  'frozen success contract is verifiably met. Explain, in plain language for a human watching the ' +
  'run, what just happened at this checkpoint. You are STRICTLY an explainer: you never make or ' +
  'influence any decision, you never re-judge whether the work is correct, and you must not suggest ' +
  'changing the contract or overriding a verdict. Be concise — 1 to 3 sentences, no markdown ' +
  'headers, no code fences.';

/**
 * The default {@link Observer}: prompts a read-only {@link LlmProvider} at each checkpoint and
 * writes the result through an injected sink. Stateful only in the iteration counter it keeps for
 * labelling ladder runs (the events themselves don't carry it) — never any run state.
 */
export class LlmObserver implements Observer {
  readonly #llm: LlmProvider;
  readonly #write: ObserverWriter;
  #iteration = 0;

  constructor(deps: { llm: LlmProvider; write: ObserverWriter }) {
    this.#llm = deps.llm;
    this.#write = deps.write;
  }

  async onEvent(event: OrchestratorEvent): Promise<void> {
    switch (event.tag) {
      case 'CONTRACT_COMPILED':
        await this.#narrate(contractPrompt(event.contract));
        return;
      case 'VERIFIED': {
        this.#iteration += 1;
        await this.#narrate(verifiedPrompt(this.#iteration, event.verdict));
        return;
      }
      case 'SIGNOFF_DECIDED':
        await this.#narrate(signoffPrompt(event.approval));
        return;
      default:
        // Every other event is not a narration checkpoint — stay silent (and cheap).
        return;
    }
  }

  async onOutcome(outcome: RunOutcome): Promise<void> {
    await this.#narrate(outcomePrompt(outcome));
  }

  /** Run one completion and emit it. Fail-closed: any error degrades to no summary. */
  async #narrate(prompt: LlmRequest): Promise<void> {
    let text: string;
    try {
      const completion = await this.#llm.complete(prompt);
      text = completion.text.trim();
    } catch {
      return; // a provider error never crashes a run — it just produces no summary
    }
    if (text.length === 0) return;
    this.#emit(text);
  }

  /** Write one summary block. A throwing writer is swallowed so observability can't crash a run. */
  #emit(text: string): void {
    const clipped = text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
    try {
      this.#write(`[explain] ${clipped}\n`);
    } catch {
      /* the output sink must never take down the orchestrator */
    }
  }
}

function rungLine(rung: Rung): string {
  return rung.kind === 'deterministic'
    ? `- deterministic command: \`${rung.command}\`${rung.label !== undefined ? ` (${rung.label})` : ''}`
    : `- judge rubric: ${rung.rubric} (quorum ${rung.quorum}, confidence floor ${rung.confidenceFloor})`;
}

function contractPrompt(contract: CompiledContract): LlmRequest {
  const rungs = contract.rungs.map(rungLine).join('\n');
  return {
    system: SYSTEM_PROMPT,
    temperature: 0,
    prompt:
      "This run's success contract has just been frozen at Seal. Explain in plain language what " +
      '"done" means for this run — what must hold for it to succeed — and that the agent cannot ' +
      'weaken this bar to declare success.\n\n' +
      `Goal: ${contract.goal}\n` +
      `Overall rubric: ${contract.rubric.length > 0 ? contract.rubric : '(none)'}\n` +
      `Verifier ladder (runs in order; every rung must pass):\n${rungs}`,
  };
}

function verifiedPrompt(iteration: number, verdict: Verdict): LlmRequest {
  const result = verdict.pass ? 'PASSED' : 'FAILED';
  const tail = verdict.pass
    ? 'what this means for the run (the approver Sign-off is next).'
    : 'what the ladder is unhappy about and what the agent will try to address next.';
  return {
    system: SYSTEM_PROMPT,
    temperature: 0,
    prompt:
      `Iteration ${iteration}'s verifier ladder just ${result}. Explain in plain language ${tail}\n\n` +
      `Result: ${result} (confidence ${verdict.confidence})\n` +
      `Details: ${verdict.detail.length > 0 ? verdict.detail : '(none provided)'}`,
  };
}

function signoffPrompt(approval: ApprovalVerdict): LlmRequest {
  const head = approval.veto
    ? 'The final approver (Sign-off) just VETOED the green ladder, so the run is NOT done yet.'
    : 'The final approver (Sign-off) just approved the green ladder.';
  return {
    system: SYSTEM_PROMPT,
    temperature: 0,
    prompt:
      `${head} The approver is veto-only — it can stop a passing run from being declared done, but ` +
      'can never promote a failing one. Explain in plain language what this means.\n\n' +
      (approval.veto && approval.reason !== undefined ? `Veto reason: ${approval.reason}` : ''),
  };
}

function outcomePrompt(outcome: RunOutcome): LlmRequest {
  const stuck = looksStuck(outcome.reason);
  return {
    system: SYSTEM_PROMPT,
    temperature: 0,
    prompt:
      `The run has ended with status ${outcome.status}. Explain in plain language why it ended and ` +
      'what it implies for the user.' +
      (stuck
        ? ' This was a "stuck" stop — the loop bailed out early rather than spinning, so name the ' +
          'reason (e.g. no-diff / repeated-failure / oscillation / harness-crash / budget) and what it suggests.'
        : '') +
      `\n\nStatus: ${outcome.status}\n` +
      `Iterations: ${outcome.iterations}\n` +
      (outcome.reason !== undefined ? `Reason: ${outcome.reason}` : ''),
  };
}
