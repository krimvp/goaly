import { describe, it, expect } from 'vitest';
import { prepareWorkspace } from './prepare';
import { makeFakeContract, FakeWorkspace, recordingLogger } from '../testing/fakes';
import type { LlmCompletion, LlmProvider, LlmRequest } from '../llm/provider';
import type { CommandResult } from '../workspace/workspace';

/**
 * The `--recontract` ANTI-SOFTENING negative control must either RUN or SAY IT DID NOT.
 *
 * Three paths reached a `proceed` — a worker turn on a re-authored bar — with the control neither
 * applied nor mentioned:
 *
 *  1. `greenNegativeControl` gated the re-contract arm on `!emptyOfSource` and then fell through to
 *     the VACUOUS arm's `generatedFiles.length === 0` gate, so a successor whose inherited tree holds
 *     no implementation source AND whose re-authored bar declares no files returned `null` with no
 *     LLM call and no log at all — exactly the bare-`--verify-cmd` softening shape the control exists
 *     to catch.
 *  2. A missing `requiredTools` program under the default install-delegation skips setup AND the whole
 *     deterministic pre-flight, so the control never runs.
 *  3. A pre-flight verifier that THROWS returns `proceed` as advisory, likewise before the control.
 *
 * These tests pin: the control runs on every re-contract path where it CAN run, and every path where
 * it genuinely cannot logs that it did not, with the reason.
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

/** A classifier that refuses a bar only when the prompt actually shows it the softened marker. */
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

const authoredFiles = [{ path: 'verify/db.test.js', sha256: 'a'.repeat(64) }];

describe('skip 1 — an inherited tree with no implementation source no longer bypasses the control', () => {
  it('bare re-authored bar + emptyOfSource ⇒ the control RUNS and can refuse', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setEmptyOfSource(true);
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
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompt).toContain('PREDECESSOR');
  });

  it('bare re-authored bar + emptyOfSource, judged sound ⇒ proceeds, but the control was ASKED', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setEmptyOfSource(true);
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

  it('an AUTHORED re-contracted bar + emptyOfSource is judged by the RE-CONTRACT arm, told the tree is empty', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setEmptyOfSource(true);
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace(
      { workspace: ws, llm, recontract: true, recontractEvidence: evidence },
      makeFakeContract({
        rungs: [{ kind: 'deterministic', command: 'node verify/db.test.js' }],
        generatedFiles: authoredFiles,
      }),
    );

    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompts).toHaveLength(1);
    // The RE-CONTRACT arm (it was shown the predecessor's bar), not the vacuous mirror.
    expect(llm.prompt).toContain('PREDECESSOR');
    // …and it is told the "the implementation on disk is correct" excuse is unavailable here.
    expect(llm.prompt).toMatch(/EMPTY OF IMPLEMENTATION SOURCE/i);
  });

  it('an ORDINARY from-scratch run is unchanged: the VACUOUS mirror still judges it', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setEmptyOfSource(true);
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace(
      { workspace: ws, llm },
      makeFakeContract({
        rungs: [{ kind: 'deterministic', command: 'node verify/db.test.js' }],
        generatedFiles: authoredFiles,
      }),
    );

    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompt).not.toContain('PREDECESSOR');
  });
});

describe('skip 2a — a missing required tool says the control did not run', () => {
  const toolBar = makeFakeContract({
    requiredTools: ['cargo'],
    setup: 'cargo fetch',
    rungs: [{ kind: 'deterministic', command: 'cargo test' }],
    generatedFiles: [],
  });

  it('missing tool + default install-delegation ⇒ proceed, and the skip is LOGGED with its reason', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 0, stdout: 'cargo\n', stderr: '' }]);
    const { logger, records } = recordingLogger();

    const result = await prepareWorkspace(
      { workspace: ws, logger, recontract: true, recontractEvidence: evidence },
      toolBar,
    );

    expect(result.prepared.status).toBe('proceed');
    if (result.prepared.status === 'proceed') {
      expect(result.prepared.installTools).toEqual(['cargo']);
    }
    const unapplied = records.filter((r) => /negative control could not run/i.test(r.msg));
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0]?.msg).toContain('cargo');
  });

  it('an ORDINARY run with a missing tool logs no control message at all', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 0, stdout: 'cargo\n', stderr: '' }]);
    const { logger, records } = recordingLogger();

    await prepareWorkspace({ workspace: ws, logger }, toolBar);

    expect(records.some((r) => /negative control could not run/i.test(r.msg))).toBe(false);
  });
});

describe('skip 2b — a pre-flight verifier that throws says the control did not run', () => {
  /** A workspace whose verify command throws (a spawn/host failure), after a clean tool probe. */
  class ThrowingWorkspace extends FakeWorkspace {
    override async run(command: string): Promise<CommandResult> {
      throw new Error(`host refused to run ${command}`);
    }
  }

  it('the rung errors ⇒ advisory proceed, and the skip is LOGGED with its reason', async () => {
    const ws = new ThrowingWorkspace();
    const { logger, records } = recordingLogger();
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace(
      { workspace: ws, logger, llm, recontract: true, recontractEvidence: evidence },
      bareBar,
    );

    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompts).toHaveLength(0); // there was no verdict to judge
    const unapplied = records.filter((r) => /negative control could not run/i.test(r.msg));
    expect(unapplied).toHaveLength(1);
    expect(unapplied[0]?.msg).toMatch(/errored|could not be executed/i);
  });

  it('an ORDINARY run whose rung errors logs no control message at all', async () => {
    const ws = new ThrowingWorkspace();
    const { logger, records } = recordingLogger();

    const result = await prepareWorkspace({ workspace: ws, logger }, bareBar);

    expect(result.prepared.status).toBe('proceed');
    expect(records.some((r) => /negative control could not run/i.test(r.msg))).toBe(false);
  });
});
