import { describe, it, expect } from 'vitest';
import { prepareWorkspace } from './prepare';
import { makeFakeContract, FakeWorkspace, recordingLogger } from '../testing/fakes';
import type { LlmCompletion, LlmProvider, LlmRequest } from '../llm/provider';
import type { CommandResult } from '../workspace/workspace';

/**
 * The `--recontract` ANTI-SOFTENING negative control must apply to a re-authored bar REGARDLESS of
 * whether that bar authored any verification files.
 *
 * `greenNegativeControl` used to return on its first line whenever `contract.generatedFiles` was
 * empty — a gate that belongs to the from-scratch VACUOUS mirror (which is about a compiler that
 * authored the solution into the frozen file set), not to the re-contract control. The net effect was
 * that the single softening shape the control most needs to catch — a successor whose "repaired" bar
 * is a bare `--verify-cmd` with no authored assertions at all — skipped the control silently, while
 * `recontract.ts` and `docs/reference.md` claimed it ran unconditionally.
 *
 * These tests pin: the control fires on a bare (no `generatedFiles`) re-contracted bar, and the two
 * places where it genuinely CANNOT run say so out loud instead of skipping in silence.
 */

/** A workspace whose `run` returns scripted results in order, recording each command it was given. */
class ScriptedWorkspace extends FakeWorkspace {
  readonly commands: string[] = [];
  readonly #results: CommandResult[];
  constructor(results: CommandResult[]) {
    super();
    this.#results = [...results];
  }
  override async run(command: string): Promise<CommandResult> {
    this.commands.push(command);
    return this.#results.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
  }
}

/** A classifier that calls a bar weakened only when the prompt shows it something to point at. */
class ReadingClassifier implements LlmProvider {
  readonly name = 'reading-classifier';
  readonly prompts: string[] = [];
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.prompts.push(req.prompt);
    const weak = req.prompt.includes('SOFTENED-BAR');
    return {
      text: JSON.stringify({
        unsound: weak,
        reason: weak ? 'the repaired bar asserts far less than the predecessor did' : 'looks sound',
      }),
    };
  }
  get prompt(): string {
    return this.prompts[0] ?? '';
  }
}

const ok: CommandResult = { exitCode: 0, stdout: '3 passed', stderr: '' };

const evidence = {
  predecessorBar: [
    'Previous frozen contract (hash abc123) — DEFECTIVE, never reused:',
    '  rubric: a database file is created on first boot and creation is idempotent',
    '  bar:',
    '    1. [deterministic] node verify/db.test.js',
  ].join('\n'),
  defect: 'the frozen check asserted on an internal _handle property the goal never implies',
};

/** The successor bar with NO authored verification files — a bare command, the weakest shape. */
const bareBar = makeFakeContract({
  goal: 'add a createDatabase bootstrap',
  rubric: 'a database file is created on first boot',
  rungs: [{ kind: 'deterministic', command: 'SOFTENED-BAR true' }],
  generatedFiles: [],
});

describe('the --recontract negative control applies to a bar with no generatedFiles', () => {
  it('a bare re-authored bar that already passes IS put to the control (and can be refused)', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace(
      { workspace: ws, llm, recontract: true, recontractEvidence: evidence },
      bareBar,
    );

    expect(result.prepared.status).toBe('contract-unsound');
    if (result.prepared.status === 'contract-unsound') {
      expect(result.prepared.detail).toContain('asserts far less');
      expect(result.prepared.detail).toMatch(/must not soften/);
    }
    // The control was really asked, and with the predecessor-side evidence it needs to compare.
    expect(llm.prompt).toContain('PREDECESSOR');
    expect(llm.prompt).toContain('_handle');
    expect(ws.commands).toEqual(['SOFTENED-BAR true']);
  });

  it('a bare re-authored bar the control judges sound still proceeds (fail-open)', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace(
      { workspace: ws, llm, recontract: true, recontractEvidence: evidence },
      makeFakeContract({
        rungs: [{ kind: 'deterministic', command: 'node verify/db.test.js' }],
        generatedFiles: [],
      }),
    );

    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompts).toHaveLength(1);
  });

  it('an ORDINARY (non-recontract) run with no generatedFiles is unchanged — no control, no LLM call', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace({ workspace: ws, llm }, bareBar);

    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompts).toHaveLength(0);
  });

  it('says so out loud when the control cannot run for want of an LLM', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const { logger, records } = recordingLogger();

    const result = await prepareWorkspace(
      { workspace: ws, logger, recontract: true, recontractEvidence: evidence },
      bareBar,
    );

    expect(result.prepared.status).toBe('proceed');
    expect(records.some((r) => /negative control could not run/i.test(r.msg))).toBe(true);
  });

  it('says so out loud when the re-authored bar has no deterministic rung to control', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const llm = new ReadingClassifier();
    const { logger, records } = recordingLogger();

    const result = await prepareWorkspace(
      { workspace: ws, llm, logger, recontract: true, recontractEvidence: evidence },
      makeFakeContract({
        rungs: [{ kind: 'judge', rubric: 'looks right', quorum: 1, confidenceFloor: 0.7 }],
        generatedFiles: [],
      }),
    );

    expect(result.prepared.status).toBe('proceed');
    expect(records.some((r) => /negative control could not run/i.test(r.msg))).toBe(true);
    expect(llm.prompts).toHaveLength(0);
  });
});
