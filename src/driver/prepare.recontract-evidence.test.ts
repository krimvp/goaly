import { describe, it, expect } from 'vitest';
import { prepareWorkspace } from './prepare';
import { makeFakeContract, FakeWorkspace, recordingLogger } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import type { LlmCompletion, LlmProvider, LlmRequest } from '../llm/provider';
import type { CommandResult } from '../workspace/workspace';

/**
 * The RE-CONTRACT negative control must be able to SEE the bar it is asked to judge.
 *
 * Before this, `classifyRecontractedBar` was handed the goal, the PATHS of the re-authored files and
 * the passing rung's stdout ("3 passed") — none of the re-authored assertions, none of the
 * predecessor's bar, and not the defect the repair was authored against. "Can a re-contract produce a
 * weaker bar that still passes the control?" was therefore yes by construction: the control had no
 * information with which to detect softening, and it fails open on top of that, so a softened bar
 * proceeded to a run whose whole premise is that the on-disk implementation is correct — i.e. straight
 * at a DONE off a weakened bar.
 *
 * These tests pin the evidence channel: the re-authored file CONTENTS (read off the inherited tree),
 * the predecessor's rendered bar, and the adjudicated defect all reach the classifier, fenced — while
 * every failure mode of that channel still proceeds, because a wrong "unsound" aborts a legitimate
 * recovery at zero iterations.
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

const ok: CommandResult = { exitCode: 0, stdout: '3 passed', stderr: '' };

const BAR_FILE = 'verify/db.test.js';
const SECOND_FILE = 'verify/idempotent.test.js';

/** The re-authored bar, softened into a tautology — passes on any tree, asserts nothing. */
const WEAKENED = "test('createDatabase', () => { expect(true).toBe(true); });";
/** A re-authored bar that still asserts the goal's observable behavior. */
const HONEST =
  "test('createDatabase', () => { createDatabase('/tmp/x'); expect(existsSync('/tmp/x')).toBe(true); });";

/** The predecessor's frozen bar (as `renderPredecessorBar` produces it) — the thing not to soften. */
const PREDECESSOR_BAR = [
  'Previous frozen contract (hash abc123) — DEFECTIVE, never reused:',
  '  rubric: a database file is created on first boot and creation is idempotent',
  '  bar:',
  '    1. [deterministic] node verify/db.test.js',
].join('\n');

/** The adjudicated defect — the ONE thing the repair was licensed to change. */
const DEFECT = 'the frozen check asserted on an internal _handle property the goal never implies';

const barContract = makeFakeContract({
  goal: 'add a createDatabase bootstrap',
  rubric: 'a database file is created on first boot and creation is idempotent',
  rungs: [{ kind: 'deterministic', command: 'node verify/db.test.js' }],
  generatedFiles: [{ path: BAR_FILE, sha256: 'a'.repeat(64) }],
});

/**
 * A classifier that behaves like a real one: it can only call the bar weakened when it is actually
 * SHOWN a tautological assertion. Blind, it has nothing to point at and — obeying its own fail-open
 * instruction — answers "sound". That is exactly the blindness this fix removes, so the same
 * classifier flips from "proceed" to "CONTRACT_UNSOUND" purely because the evidence now reaches it.
 */
class ReadingClassifier implements LlmProvider {
  readonly name = 'reading-classifier';
  readonly prompts: string[] = [];
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.prompts.push(req.prompt);
    const sawTautology = req.prompt.includes('expect(true).toBe(true)');
    return {
      text: JSON.stringify({
        unsound: sawTautology,
        reason: sawTautology
          ? 'the re-authored file asserts a tautology; the predecessor asserted the file is created'
          : 'nothing visible that I can call weaker than the goal',
      }),
    };
  }
  get prompt(): string {
    return this.prompts[0] ?? '';
  }
}

const evidence = { predecessorBar: PREDECESSOR_BAR, defect: DEFECT };

describe('the re-contract negative control sees the bar it judges (weakening is detectable)', () => {
  it('a deliberately WEAKENED re-authored bar is caught — the same classifier was blind before', async () => {
    const ws = new ScriptedWorkspace([ok]); // green on the inherited tree, before any worker turn
    ws.setFileContent(BAR_FILE, WEAKENED);
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace(
      { workspace: ws, llm, recontract: true, recontractEvidence: evidence },
      barContract,
    );

    expect(result.prepared.status).toBe('contract-unsound');
    if (result.prepared.status === 'contract-unsound') {
      expect(result.prepared.detail).toContain('asserts a tautology');
      expect(result.prepared.detail).toMatch(/must not soften/);
    }
    expect(ws.commands).toEqual(['node verify/db.test.js']); // the bar WAS run on the inherited tree
  });

  it('the SAME weakened bar is judged sound when the control is not shown it (the old blindness)', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setFileContent(BAR_FILE, WEAKENED);
    const llm = new ReadingClassifier();

    // No readable content and no predecessor-side evidence: the classifier sees only paths + "3
    // passed", exactly as before — and, correctly for a fail-open control, proceeds.
    const result = await prepareWorkspace(
      { workspace: ws, llm, recontract: true, readFile: async () => null },
      barContract,
    );

    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompt).not.toContain('expect(true).toBe(true)');
  });

  it('an HONEST re-authored bar that passes because the implementation is correct still proceeds', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setFileContent(BAR_FILE, HONEST);
    const llm = new ReadingClassifier();

    const result = await prepareWorkspace(
      { workspace: ws, llm, recontract: true, recontractEvidence: evidence },
      barContract,
    );

    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompt).toContain(HONEST); // it WAS shown the bar; it simply found nothing weak
  });

  it('the prompt carries the re-authored assertions, the predecessor bar and the defect — all fenced', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setFileContent(BAR_FILE, WEAKENED);
    const llm = new ReadingClassifier();

    await prepareWorkspace(
      { workspace: ws, llm, recontract: true, recontractEvidence: evidence },
      barContract,
    );

    const prompt = llm.prompt;
    expect(prompt).toContain(WEAKENED); // (a) the re-authored assertions
    expect(prompt).toContain(PREDECESSOR_BAR); // (b) the bar being repaired
    expect(prompt).toContain(DEFECT); // (c) the adjudicated defect
    // The new bar's own rungs/rubric are shown too, so old and new are comparable side by side.
    expect(prompt).toContain('node verify/db.test.js');
    expect(prompt).toContain('a database file is created on first boot');
    // Every piece of it is model/worker-influenced text, so every piece is fenced as untrusted.
    for (const label of ['AUTHORED FILE', 'PREDECESSOR BAR', 'ADJUDICATION']) {
      expect(prompt).toMatch(new RegExp(`<<UNTRUSTED ${label} [0-9a-f]+>>`));
    }
  });
});

describe('the evidence channel is fail-open at every grain', () => {
  it('a readFile that THROWS drops that file only — the other file is still shown, the run proceeds', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const twoFiles = makeFakeContract({
      goal: 'add a createDatabase bootstrap',
      rungs: [{ kind: 'deterministic', command: 'node verify/db.test.js' }],
      generatedFiles: [
        { path: BAR_FILE, sha256: 'a'.repeat(64) },
        { path: SECOND_FILE, sha256: 'b'.repeat(64) },
      ],
    });
    const llm = new ReadingClassifier();
    const { logger, records } = recordingLogger();

    const result = await prepareWorkspace(
      {
        workspace: ws,
        llm,
        recontract: true,
        recontractEvidence: evidence,
        logger,
        readFile: async (rel) => {
          if (rel === BAR_FILE) throw new Error('EACCES');
          return HONEST;
        },
      },
      twoFiles,
    );

    expect(result.prepared.status).toBe('proceed');
    // The readable file is still quoted; the unreadable one contributes no content section.
    expect(llm.prompt).toContain(`RE-AUTHORED VERIFICATION FILE ${SECOND_FILE}`);
    expect(llm.prompt).not.toContain(`RE-AUTHORED VERIFICATION FILE ${BAR_FILE}`);
    expect(records.map((r) => r.msg).join('\n')).toContain('could not read');
  });

  it('an unparseable verdict still proceeds even with the full evidence in hand', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setFileContent(BAR_FILE, WEAKENED);
    const result = await prepareWorkspace(
      {
        workspace: ws,
        llm: new FakeLlm(['I would rather write you an essay about test quality']),
        recontract: true,
        recontractEvidence: evidence,
      },
      barContract,
    );
    expect(result.prepared.status).toBe('proceed');
  });

  it('reads through the WORKSPACE by default (no separate reader needed to see the bar)', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setFileContent(BAR_FILE, WEAKENED);
    const llm = new ReadingClassifier();
    const result = await prepareWorkspace(
      { workspace: ws, llm, recontract: true, recontractEvidence: evidence },
      barContract,
    );
    expect(result.prepared.status).toBe('contract-unsound');
  });

  it('an ORDINARY green run never reads the tree or consults the control', async () => {
    const ws = new ScriptedWorkspace([ok]);
    ws.setFileContent(BAR_FILE, WEAKENED);
    const llm = new ReadingClassifier();
    const result = await prepareWorkspace({ workspace: ws, llm }, barContract);
    expect(result.prepared.status).toBe('proceed');
    expect(llm.prompts).toHaveLength(0);
  });
});
