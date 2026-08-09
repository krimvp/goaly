import { describe, it, expect } from 'vitest';
import { AgentCompiler } from './agent-compiler';
import { prepareWorkspace } from '../driver/prepare';
import { FakeLlm } from '../llm/provider';
import { FakeWorkspace, makeConfig } from '../testing/fakes';
import type { CommandResult } from '../workspace/workspace';
import { formatDefectSection, selectDefectHints } from '../defects/select';
import { DEFECT_RECORD_VERSION, type DefectRecord } from '../defects/corpus';

/**
 * Issue #122 — the READ half: the corpus reaches the compiler's AUTHORING prompt (bounded, and
 * framed as impossibility), and a bar authored under its influence is still put to every downstream
 * gate — the pre-flight NEGATIVE CONTROL above all.
 */

const authored = JSON.stringify({
  command: 'npx --no-install vitest run verify/db.test.ts',
  rubric: 'createDatabase bootstraps the schema',
  files: [{ path: 'verify/db.test.ts', content: 'import { it } from "vitest";' }],
});

function record(over: Partial<DefectRecord> = {}): DefectRecord {
  return {
    v: DEFECT_RECORD_VERSION,
    ts: '2026-01-01T00:00:00.000Z',
    pattern: 'asserts a spy call count after the spy was restored',
    language: 'typescript',
    runner: 'vitest',
    contractHash: 'c'.repeat(64),
    runId: 'run-old',
    ...over,
  } as DefectRecord;
}

const section = (): string =>
  formatDefectSection(
    selectDefectHints([record()], { languages: ['typescript'], runners: ['vitest'] }),
  );

describe('the corpus reaches contract authoring — bounded and correctly framed', () => {
  it('injects the known false-red patterns into the --generate authoring prompt', async () => {
    const llm = new FakeLlm([authored]);
    const compiler = new AgentCompiler({ llm, defectSection: section() });
    await compiler.compile(makeConfig({ verifier: { kind: 'generate', intent: undefined } }));

    const prompt = llm.requests[0]?.prompt ?? '';
    expect(prompt).toContain('asserts a spy call count after the spy was restored');
    expect(prompt).toContain('DO NOT AUTHOR THESE');
    // The framing the issue demands: impossibility, never "make the bar easier".
    expect(prompt).toMatch(/never a reason to make the bar easier/);
  });

  it('an empty/absent section leaves the prompt byte-for-byte as it was', async () => {
    const withOut = new FakeLlm([authored]);
    await new AgentCompiler({ llm: withOut }).compile(
      makeConfig({ verifier: { kind: 'generate', intent: undefined } }),
    );
    const blank = new FakeLlm([authored]);
    await new AgentCompiler({ llm: blank, defectSection: '   ' }).compile(
      makeConfig({ verifier: { kind: 'generate', intent: undefined } }),
    );
    expect(blank.requests[0]?.prompt).toBe(withOut.requests[0]?.prompt);
  });

  it('the prompt stays bounded no matter how large the corpus is', async () => {
    const huge = Array.from({ length: 10_000 }, (_, i) => record({ pattern: `pattern ${i}` }));
    const bounded = formatDefectSection(
      selectDefectHints(huge, { languages: ['typescript'], runners: ['vitest'] }),
    );
    const llm = new FakeLlm([authored]);
    await new AgentCompiler({ llm, defectSection: bounded }).compile(
      makeConfig({ verifier: { kind: 'generate', intent: undefined } }),
    );
    const prompt = llm.requests[0]?.prompt ?? '';
    expect(bounded.length).toBeLessThan(2000);
    expect(prompt.length).toBeLessThan(4000);
  });

  it('the corpus never touches the --verify-cmd path (a user bar is the user\'s own)', async () => {
    const llm = new FakeLlm([]);
    const compiler = new AgentCompiler({ llm, defectSection: section() });
    await compiler.compile(makeConfig({ verifier: { kind: 'existing', ref: 'npm test' } }));
    expect(llm.requests).toHaveLength(0);
  });
});

describe('a corpus-influenced contract still faces the NEGATIVE CONTROL', () => {
  class ScriptedWorkspace extends FakeWorkspace {
    constructor(private readonly result: CommandResult) {
      super();
    }
    override async run(): Promise<CommandResult> {
      return this.result;
    }
  }

  it('a corpus-shaped bar that already passes on a from-scratch tree is still CONTRACT_UNSOUND', async () => {
    const compiler = new AgentCompiler({ llm: new FakeLlm([authored]), defectSection: section() });
    const contract = await compiler.compile(
      makeConfig({ verifier: { kind: 'generate', intent: undefined } }),
    );
    // The authored bar must be pinned as compiler-authored for the GREEN mirror to apply.
    const withFiles = {
      ...contract,
      generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
    };

    const ws = new ScriptedWorkspace({ exitCode: 0, stdout: '', stderr: '' }); // GREEN at t=0
    ws.setEmptyOfSource(true);
    const llm = new FakeLlm([JSON.stringify({ unsound: true, reason: 'the bar is vacuous' })]);
    const result = await prepareWorkspace({ workspace: ws, llm }, withFiles);

    expect(result.prepared.status).toBe('contract-unsound');
    expect(llm.requests).toHaveLength(1); // the control WAS consulted
  });

  it('and an honest RED from-scratch bar still proceeds (the control is not a new gate)', async () => {
    const compiler = new AgentCompiler({ llm: new FakeLlm([authored]), defectSection: section() });
    const contract = await compiler.compile(
      makeConfig({ verifier: { kind: 'generate', intent: undefined } }),
    );
    const ws = new ScriptedWorkspace({ exitCode: 1, stdout: 'no such file', stderr: '' });
    ws.setEmptyOfSource(true);
    const llm = new FakeLlm([
      JSON.stringify({ brokenVerification: false, reason: 'not written yet' }),
    ]);
    const result = await prepareWorkspace(
      { workspace: ws, llm },
      { ...contract, generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }] },
    );
    expect(result.prepared.status).toBe('proceed');
  });
});
