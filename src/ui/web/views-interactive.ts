import { h, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import type { PendingGate, StartRunRequest } from '../api-schema';
import { api } from './api';
import { truncate } from './format';

const html = htm.bind(h);

/**
 * The interactive views (ADR 0015): the start-run form and the Seal / plan-Seal modal. The seal
 * modal is the POINT of a non-autonomous UI run — the frozen contract is presented for
 * approve / revise-with-feedback / reject exactly like the CLI prompt, against a `gateId` so a
 * double-submit can never answer a later gate.
 */

// ---- start-run form ----------------------------------------------------------

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
    <h2 style="margin-top:0">start a run</h2>
    ${error !== undefined ? html`<div class="error-box">${error}</div>` : ''}

    <label>goal
      <textarea rows="3" required value=${goal}
        placeholder="add a /health endpoint returning 200"
        onInput=${(e: Event): void => setGoal((e.target as HTMLTextAreaElement).value)}></textarea>
    </label>

    <div class="field-row">
      <label class="inline">
        <input type="radio" name="verify" checked=${verifyMode === 'verify-cmd'}
          onChange=${(): void => setVerifyMode('verify-cmd')} />
        verify command
      </label>
      <label class="inline">
        <input type="radio" name="verify" checked=${verifyMode === 'generate'}
          onChange=${(): void => setVerifyMode('generate')} />
        generate the verification (--generate)
      </label>
    </div>
    ${verifyMode === 'verify-cmd'
      ? html`<label>verify command (must exit 0)
          <input type="text" required value=${verifyCmd} placeholder="npm test" class="mono"
            onInput=${(e: Event): void => setVerifyCmd((e.target as HTMLInputElement).value)} />
        </label>`
      : ''}

    <div class="field-row">
      <label>harness
        <select value=${harness} onChange=${(e: Event): void => setHarness((e.target as HTMLSelectElement).value)}>
          ${['claude', 'codex', 'droid', 'pi', 'goaly-code', 'fake'].map((name) => html`<option value=${name}>${name}</option>`)}
        </select>
      </label>
      <label>model <span class="muted">(optional)</span>
        <input type="text" value=${model} onInput=${(e: Event): void => setModel((e.target as HTMLInputElement).value)} />
      </label>
      <label>max iterations
        <input type="number" min="1" value=${maxIterations} placeholder="10"
          onInput=${(e: Event): void => setMaxIterations((e.target as HTMLInputElement).value)} />
      </label>
      <label>budget (tokens)
        <input type="number" min="1" value=${budgetTokens}
          onInput=${(e: Event): void => setBudgetTokens((e.target as HTMLInputElement).value)} />
      </label>
    </div>

    <label class="inline">
      <input type="checkbox" checked=${autonomous}
        onChange=${(e: Event): void => setAutonomous((e.target as HTMLInputElement).checked)} />
      autonomous — auto-accept the (still-frozen, still-logged) contract; unchecked parks the run
      at the Seal so YOU approve the bar here
    </label>

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

    <button class="linkish primary" disabled=${busy} type="submit">${busy ? 'starting…' : 'start run'}</button>
  </form>` as VNode;
}

// ---- seal / plan-seal modal ----------------------------------------------------

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

  const answer = async (decision: 'approve' | 'reject' | 'revise'): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      await api.answerGate(
        runId,
        gate.gateId,
        decision === 'revise' ? { decision, feedback } : { decision },
      );
      onResolved(gate.gateId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return html`<div class="modal-backdrop">
    <div class="card modal">
      <h2 style="margin-top:0">
        ${gate.kind === 'seal' ? 'Seal — approve the success contract' : 'Plan Seal — approve the plan'}
      </h2>
      <p class="muted" style="margin-top:0">
        This is the bar the run will be held to. Once approved it is FROZEN — no transition can
        rewrite it (revise re-authors and re-presents it).
      </p>
      ${gate.kind === 'seal'
        ? html`<div class="contract">
            <div class="mono muted">contractHash: ${gate.contract.contractHash}</div>
            <div><b>goal:</b> ${gate.contract.goal}</div>
            ${gate.contract.setup !== undefined ? html`<div><b>setup:</b> <code>${gate.contract.setup}</code></div>` : ''}
            ${gate.contract.requiredTools.length > 0
              ? html`<div><b>required tools:</b> ${gate.contract.requiredTools.join(', ')}</div>`
              : ''}
            <ol>
              ${gate.contract.rungs.map((rung) =>
                rung.kind === 'deterministic'
                  ? html`<li>deterministic: <code>${rung.command}</code></li>`
                  : html`<li>judge (quorum ${rung.quorum}): ${truncate(rung.rubric, 220)}</li>`,
              )}
            </ol>
            ${gate.contract.rubric.length > 0 ? html`<div><b>rubric:</b> ${truncate(gate.contract.rubric, 300)}</div>` : ''}
            ${gate.contract.generatedFiles.length > 0
              ? html`<div class="muted">authored files: ${gate.contract.generatedFiles.map((f) => f.path).join(', ')}</div>`
              : ''}
          </div>`
        : html`<div class="contract">
            <div class="mono muted">planHash: ${gate.plan.planHash}</div>
            <ol>${gate.plan.phases.map((p) => html`<li>${p.goal}</li>`)}</ol>
          </div>`}
      ${error !== undefined ? html`<div class="error-box">${error}</div>` : ''}
      <label>revision feedback <span class="muted">(required only for revise)</span>
        <textarea rows="2" value=${feedback}
          onInput=${(e: Event): void => setFeedback((e.target as HTMLTextAreaElement).value)}></textarea>
      </label>
      <div class="field-row">
        <button class="linkish primary" disabled=${busy} onClick=${(): void => void answer('approve')}>approve</button>
        <button class="linkish" disabled=${busy || feedback.trim() === ''} onClick=${(): void => void answer('revise')}>revise with feedback</button>
        <button class="linkish danger" disabled=${busy} onClick=${(): void => void answer('reject')}>reject (abort)</button>
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

  return html`<div class="card">
    <h2 style="margin-top:0">resume this run</h2>
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
