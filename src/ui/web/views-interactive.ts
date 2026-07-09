import { h, type VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import type { GateFileEntry, PendingGate, StartRunRequest } from '../api-schema';
import { api } from './api';
import { buildSealPatch, sealFieldsOf, truncate, type SealFieldEdits } from './format';

const html = htm.bind(h);

/**
 * The interactive views (ADR 0015): the launch console and the Seal / plan-Seal modal. The seal
 * modal is the POINT of a non-autonomous UI run — the frozen contract is presented for
 * approve / revise-with-feedback / reject exactly like the CLI prompt, against a `gateId` so a
 * double-submit can never answer a later gate.
 */

// ---- launch console ----------------------------------------------------------

export function StartRunPage(): VNode {
  const [goal, setGoal] = useState('');
  const [verifyMode, setVerifyMode] = useState<'verify-cmd' | 'generate'>('verify-cmd');
  const [verifyCmd, setVerifyCmd] = useState('');
  const [harness, setHarness] = useState('claude');
  const [autonomous, setAutonomous] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [worktreeName, setWorktreeName] = useState('');
  const [maxIterations, setMaxIterations] = useState('');
  const [budgetTokens, setBudgetTokens] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const req = {
        goal,
        ...(verifyMode === 'verify-cmd' ? { verifyCmd } : { generate: true }),
        harness: harness as StartRunRequest['harness'],
        autonomous,
        ...(maxIterations !== '' ? { maxIterations: Number(maxIterations) } : {}),
        ...(budgetTokens !== '' ? { budgetTokens: Number(budgetTokens) } : {}),
        ...(model !== '' ? { model } : {}),
        ...(useWorktree && worktreeName !== '' ? { worktree: { name: worktreeName } } : {}),
      } as StartRunRequest;
      const { runId } = await api.startRun(req);
      location.hash = `#/runs/${runId}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return html`<form class="card start-form" onSubmit=${submit}>
    <h2 class="console-title">launch a mission</h2>
    <p class="muted lede">
      The goal is compiled into a frozen success contract; the agent loops until the contract is
      verifiably met — and can never weaken the bar to pass.
    </p>
    ${error !== undefined ? html`<div class="error-box">${error}</div>` : ''}

    <fieldset>
      <legend><span class="step-no">01</span> objective</legend>
      <label>goal
        <textarea rows="3" required value=${goal}
          placeholder="add a /health endpoint returning 200"
          onInput=${(e: Event): void => setGoal((e.target as HTMLTextAreaElement).value)}></textarea>
      </label>
    </fieldset>

    <fieldset>
      <legend><span class="step-no">02</span> verification — the bar that gets frozen</legend>
      <div class="field-row">
        <label class="inline">
          <input type="radio" name="verify" checked=${verifyMode === 'verify-cmd'}
            onChange=${(): void => setVerifyMode('verify-cmd')} />
          I have a verify command
        </label>
        <label class="inline">
          <input type="radio" name="verify" checked=${verifyMode === 'generate'}
            onChange=${(): void => setVerifyMode('generate')} />
          generate the verification (<code>--generate</code>)
        </label>
      </div>
      ${verifyMode === 'verify-cmd'
        ? html`<label>verify command (must exit 0)
            <input type="text" required value=${verifyCmd} placeholder="npm test" class="mono"
              onInput=${(e: Event): void => setVerifyCmd((e.target as HTMLInputElement).value)} />
          </label>`
        : ''}
    </fieldset>

    <fieldset>
      <legend><span class="step-no">03</span> execution</legend>
      <div class="field-row">
        <label>harness
          <select value=${harness} onChange=${(e: Event): void => setHarness((e.target as HTMLSelectElement).value)}>
            ${['claude', 'codex', 'droid', 'pi', 'goaly-code', 'fake'].map((name) => html`<option value=${name}>${name}</option>`)}
          </select>
        </label>
        <label>model <span class="muted">(optional)</span>
          <input type="text" value=${model} onInput=${(e: Event): void => setModel((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <label class="inline">
        <input type="checkbox" checked=${useWorktree}
          onChange=${(e: Event): void => setUseWorktree((e.target as HTMLInputElement).checked)} />
        run in a worktree (isolated checkout — the main tree is never touched)
      </label>
      ${useWorktree
        ? html`<label>worktree name
            <input type="text" required value=${worktreeName} placeholder="feature-x" class="mono"
              onInput=${(e: Event): void => setWorktreeName((e.target as HTMLInputElement).value)} />
          </label>`
        : ''}
      <label class="inline">
        <input type="checkbox" checked=${autonomous}
          onChange=${(e: Event): void => setAutonomous((e.target as HTMLInputElement).checked)} />
        autonomous — auto-accept the (still-frozen, still-logged) contract; unchecked parks the run
        at the Seal so YOU approve the bar here
      </label>
    </fieldset>

    <fieldset>
      <legend><span class="step-no">04</span> limits</legend>
      <div class="field-row">
        <label>max iterations
          <input type="number" min="1" value=${maxIterations} placeholder="10"
            onInput=${(e: Event): void => setMaxIterations((e.target as HTMLInputElement).value)} />
        </label>
        <label>budget (tokens)
          <input type="number" min="1" value=${budgetTokens}
            onInput=${(e: Event): void => setBudgetTokens((e.target as HTMLInputElement).value)} />
        </label>
      </div>
    </fieldset>

    <button class="linkish primary launch" disabled=${busy} type="submit">${busy ? 'igniting…' : '▶ launch'}</button>
  </form>` as VNode;
}

// ---- seal / plan-seal modal: the review station (ADR 0016) ----------------------

/** Per-file review state: server truth + the operator's unsaved in-UI edit. */
type FileReview = GateFileEntry & { draft: string | null; open: boolean };

export function SealModal({
  runId,
  gate,
  onResolved,
}: {
  runId: string;
  gate: PendingGate;
  onResolved: (gateId: string) => void;
}): VNode {
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<FileReview[]>([]);
  const [fields, setFields] = useState<SealFieldEdits | undefined>(
    gate.kind === 'seal' ? sealFieldsOf(gate.contract) : undefined,
  );

  useEffect(() => {
    if (gate.kind !== 'seal' || gate.contract.generatedFiles.length === 0) return;
    api.gateFiles(runId, gate.gateId).then(
      (res) => {
        if (res !== null) setFiles(res.files.map((f) => ({ ...f, draft: null, open: false })));
      },
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.gateId]);

  const unsavedEdits = files.some((f) => f.draft !== null && f.draft !== f.content);
  const dirtyOnDisk = files.some((f) => f.dirty);
  const fieldPatch =
    gate.kind === 'seal' && fields !== undefined ? buildSealPatch(gate.contract, fields) : undefined;

  const answer = async (decision: 'approve' | 'reject' | 'revise' | 'edited'): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      if (decision === 'edited') {
        // Save every unsaved in-UI file edit FIRST, then re-freeze with the field patch — one
        // review round picks up all of it (plus any edits made on disk in your own editor).
        for (const file of files) {
          if (file.draft !== null && file.draft !== file.content) {
            await api.putGateFile(runId, gate.gateId, { path: file.path, content: file.draft });
          }
        }
        await api.answerGate(runId, gate.gateId, {
          decision: 'edited',
          ...(fieldPatch !== undefined ? { patch: fieldPatch } : {}),
        });
      } else {
        await api.answerGate(
          runId,
          gate.gateId,
          decision === 'revise' ? { decision, feedback } : { decision },
        );
      }
      onResolved(gate.gateId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const updateFile = (path: string, mutate: (f: FileReview) => FileReview): void =>
    setFiles((prev) => prev.map((f) => (f.path === path ? mutate(f) : f)));

  return html`<div class="modal-backdrop">
    <div class="card modal">
      <h2 class="console-title">
        ${gate.kind === 'seal' ? '⬡ Seal — review & approve the success contract' : '⬡ Plan Seal — approve the plan'}
      </h2>
      <p class="muted" style="margin-top:0">
        This is the bar the run will be held to. Once approved it is FROZEN — no transition can
        rewrite it. Ask for changes (revise), or edit the artifacts yourself — here or in your own
        editor — and re-freeze until you're happy. Only then does execution start.
      </p>
      ${gate.kind === 'seal'
        ? html`<div class="contract">
            <div class="mono muted">contractHash: ${gate.contract.contractHash}</div>
            <div><b>goal:</b> ${gate.contract.goal}</div>
            ${gate.contract.requiredTools.length > 0
              ? html`<div><b>required tools:</b> ${gate.contract.requiredTools.join(', ')}</div>`
              : ''}
          </div>`
        : html`<div class="contract">
            <div class="mono muted">planHash: ${gate.plan.planHash}</div>
            <ol>${gate.plan.phases.map((p) => html`<li>${p.goal}</li>`)}</ol>
          </div>`}

      ${gate.kind === 'seal' && fields !== undefined
        ? html`<div class="contract">
            <label>setup command <span class="muted">(one-time, before iteration 1 — empty = none)</span>
              <input type="text" class="mono" value=${fields.setup} disabled=${busy}
                onInput=${(e: Event): void =>
                  setFields({ ...fields, setup: (e.target as HTMLInputElement).value })} />
            </label>
            ${gate.contract.rungs.map((rung, index) =>
              rung.kind === 'deterministic'
                ? html`<label>rung ${index} — deterministic command
                    <input type="text" class="mono" value=${fields.commands[index] ?? ''} disabled=${busy}
                      onInput=${(e: Event): void => {
                        const commands = [...fields.commands];
                        commands[index] = (e.target as HTMLInputElement).value;
                        setFields({ ...fields, commands });
                      }} />
                  </label>`
                : html`<div class="muted" style="margin:0.4rem 0">
                    rung ${index} — judge (quorum ${rung.quorum}): ${truncate(rung.rubric, 180)}
                  </div>`,
            )}
            <label>rubric <span class="muted">(what the judge / approver hold the work to)</span>
              <textarea rows="2" value=${fields.rubric} disabled=${busy}
                onInput=${(e: Event): void =>
                  setFields({ ...fields, rubric: (e.target as HTMLTextAreaElement).value })}></textarea>
            </label>
          </div>`
        : ''}

      ${files.map(
        (file) => html`<div class="contract">
          <div class="field-row" style="align-items:center">
            <span class="mono">${file.path}</span>
            ${file.sha256OnDisk === null
              ? html`<span class="badge corrupt">MISSING ON DISK</span>`
              : file.dirty
                ? html`<span class="badge incomplete">changed on disk since frozen</span>`
                : ''}
            ${file.draft !== null && file.draft !== file.content
              ? html`<span class="badge incomplete">unsaved edit</span>`
              : ''}
            <button class="linkish" disabled=${busy}
              onClick=${(): void => updateFile(file.path, (f) => ({ ...f, open: !f.open }))}>
              ${file.open ? 'collapse' : file.draft !== null ? 'edit' : 'view / edit'}
            </button>
          </div>
          ${file.open
            ? html`<textarea rows="12" class="mono" disabled=${busy}
                  value=${file.draft ?? file.content ?? ''}
                  onInput=${(e: Event): void =>
                    updateFile(file.path, (f) => ({ ...f, draft: (e.target as HTMLTextAreaElement).value }))}></textarea>
                ${file.truncated ? html`<div class="muted">content truncated for display — edit on disk for the full file</div>` : ''}`
            : ''}
        </div>`,
      )}

      ${error !== undefined ? html`<div class="error-box" style="white-space:pre-wrap">${error}</div>` : ''}
      ${gate.kind === 'seal'
        ? html`<div class="field-row" style="margin-top:0.6rem">
            <button class="linkish" disabled=${busy || (!unsavedEdits && fieldPatch === undefined && !dirtyOnDisk)}
              onClick=${(): void => void answer('edited')}>
              re-freeze & review${unsavedEdits ? ' (saves your edits)' : ''}
            </button>
            <button class="linkish" disabled=${busy} onClick=${(): void => void answer('edited')}
              title="Pick up edits made in your own editor: re-read the authored files from disk and re-freeze">
              refresh from disk
            </button>
          </div>`
        : ''}
      <label>revision feedback <span class="muted">(required only for revise — the LLM re-authors from it)</span>
        <textarea rows="2" value=${feedback} disabled=${busy}
          onInput=${(e: Event): void => setFeedback((e.target as HTMLTextAreaElement).value)}></textarea>
      </label>
      <div class="field-row">
        <button class="linkish primary" disabled=${busy || unsavedEdits || fieldPatch !== undefined}
          title=${unsavedEdits || fieldPatch !== undefined ? 're-freeze your edits first' : ''}
          onClick=${(): void => void answer('approve')}>✓ approve & start</button>
        <button class="linkish" disabled=${busy || feedback.trim() === ''} onClick=${(): void => void answer('revise')}>↻ revise with feedback</button>
        <button class="linkish danger" disabled=${busy} onClick=${(): void => void answer('reject')}>✕ reject (abort)</button>
      </div>
    </div>
  </div>` as VNode;
}

// ---- resume panel ---------------------------------------------------------------

export function ResumePanel({ runId }: { runId: string }): VNode {
  const [note, setNote] = useState('');
  const [maxIterations, setMaxIterations] = useState('');
  const [budgetTokens, setBudgetTokens] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const resume = async (): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      await api.resumeRun(runId, {
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
        ...(maxIterations !== '' ? { maxIterations: Number(maxIterations) } : {}),
        ...(budgetTokens !== '' ? { budgetTokens: Number(budgetTokens) } : {}),
      });
      location.reload(); // re-subscribe to the (now live again) run
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return html`<div class="resume-panel">
    <h4>▶ resume this run</h4>
    <p class="muted" style="margin-top:0">
      Continue where the log left off — optionally raise the OPERATIONAL caps or steer the worker
      with a note. The goal, verifier, and rubric are structurally not extendable (the bar stays frozen).
    </p>
    ${error !== undefined ? html`<div class="error-box">${error}</div>` : ''}
    <label>note to the worker <span class="muted">(appended to its next prompt)</span>
      <input type="text" value=${note} onInput=${(e: Event): void => setNote((e.target as HTMLInputElement).value)} />
    </label>
    <div class="field-row">
      <label>max iterations
        <input type="number" min="1" value=${maxIterations}
          onInput=${(e: Event): void => setMaxIterations((e.target as HTMLInputElement).value)} />
      </label>
      <label>budget (tokens)
        <input type="number" min="1" value=${budgetTokens}
          onInput=${(e: Event): void => setBudgetTokens((e.target as HTMLInputElement).value)} />
      </label>
      <button class="linkish primary" disabled=${busy} onClick=${(): void => void resume()}>
        ${busy ? 'resuming…' : 'resume'}
      </button>
    </div>
  </div>` as VNode;
}
