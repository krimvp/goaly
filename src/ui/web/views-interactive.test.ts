// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { StartRunPage, SealModal, ResumePanel } from './views-interactive';
import { makeFakeContract, makeFakePlan } from '../../testing/fakes';
import type { PendingGate } from '../api-schema';

/**
 * The interactive views under happy-dom: the launch console composes a valid StartRunRequest from
 * the form, and the Seal modal answers its gate against the right gateId — the double-submit guard
 * the whole ADR 0015 design hangs on.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

async function until(cond: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if (!cond()) throw new Error('condition not met');
    },
    { timeout: 2000, interval: 5 },
  );
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('StartRunPage', () => {
  it('submits the composed StartRunRequest and navigates to the new run', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ runId: 'run-new-1' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    render(h(StartRunPage, {}), root);

    setValue(root.querySelector('textarea') as HTMLTextAreaElement, 'add a /health endpoint');
    setValue(root.querySelector('input[type="text"].mono') as HTMLInputElement, 'npm test');
    await until(() => (root.querySelector('textarea') as HTMLTextAreaElement).value !== '');

    const form = root.querySelector('form');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => fetchMock.mock.calls.length > 0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/runs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      goal: 'add a /health endpoint',
      verifyCmd: 'npm test',
      harness: 'claude',
      autonomous: false,
    });
    await until(() => location.hash === '#/runs/run-new-1');
  });

  it('surfaces a server refusal in the error box instead of navigating', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'choose exactly one of verifyCmd / generate' }, 400)));
    location.hash = '#/new';
    render(h(StartRunPage, {}), root);

    setValue(root.querySelector('textarea') as HTMLTextAreaElement, 'goal');
    setValue(root.querySelector('input[type="text"].mono') as HTMLInputElement, 'true');
    const form = root.querySelector('form');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await until(() => (root.textContent ?? '').includes('choose exactly one of verifyCmd / generate'));
    expect(location.hash).toBe('#/new');
  });
});

describe('SealModal', () => {
  const contract = makeFakeContract({
    goal: 'seal me',
    rungs: [
      { kind: 'deterministic', command: 'npm test' },
      { kind: 'judge', rubric: 'does it work well', quorum: 2, confidenceFloor: 0.7 },
    ],
    rubric: 'overall rubric',
  });
  const gate: PendingGate = { gateId: 'gate-7', kind: 'seal', contract };

  it('renders the frozen contract and approves against the exact gateId', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ resolved: 'gate-7' }));
    vi.stubGlobal('fetch', fetchMock);
    const onResolved = vi.fn();
    render(h(SealModal, { runId: 'run-1', gate, onResolved }), root);

    const text = root.textContent ?? '';
    expect(text).toContain('seal me');
    expect(text).toContain(contract.contractHash);
    expect(text).toContain('does it work well'); // the judge rung's rubric, read-only

    const approve = [...root.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('approve & start'),
    ) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    approve.click();
    await until(() => onResolved.mock.calls.length > 0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/runs/run-1/gate/gate-7');
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'approve' });
    expect(onResolved).toHaveBeenCalledWith('gate-7');
  });

  it('revise requires feedback and sends it with the decision', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ resolved: 'gate-7' }));
    vi.stubGlobal('fetch', fetchMock);
    const onResolved = vi.fn();
    render(h(SealModal, { runId: 'run-1', gate, onResolved }), root);

    const revise = [...root.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('revise with feedback'),
    ) as HTMLButtonElement;
    expect(revise.disabled).toBe(true); // no feedback yet

    const feedbackBoxes = [...root.querySelectorAll('textarea')];
    const feedback = feedbackBoxes[feedbackBoxes.length - 1] as HTMLTextAreaElement;
    setValue(feedback, 'tighten the bar');
    await until(() => revise.disabled === false);
    revise.click();
    await until(() => onResolved.mock.calls.length > 0);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'revise', feedback: 'tighten the bar' });
  });

  it('editing a contract field forces re-freeze before approve', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    render(h(SealModal, { runId: 'run-1', gate, onResolved: vi.fn() }), root);

    const rubricBox = [...root.querySelectorAll('textarea')][0] as HTMLTextAreaElement;
    setValue(rubricBox, 'a different rubric');

    const approve = [...root.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('approve & start'),
    ) as HTMLButtonElement;
    await until(() => approve.disabled === true);
  });

  it('renders a plan gate as the ordered phase list', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    const planGate: PendingGate = { gateId: 'gate-8', kind: 'plan', plan: makeFakePlan() };
    render(h(SealModal, { runId: 'run-1', gate: planGate, onResolved: vi.fn() }), root);
    const text = root.textContent ?? '';
    expect(text).toContain('approve the plan');
    expect(text).toContain('phase one');
    expect(text).toContain('phase two');
  });
});

describe('ResumePanel', () => {
  it('shows the server refusal when resume fails (and never navigates)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'run is already live' }, 409)));
    render(h(ResumePanel, { runId: 'run-1' }), root);

    const resume = [...root.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('resume'),
    ) as HTMLButtonElement;
    resume.click();
    await until(() => (root.textContent ?? '').includes('run is already live'));
  });

  it('sends only the caps the operator actually set', async () => {
    // Success path reloads the page, which happy-dom cannot do — intercept it.
    const fetchMock = vi.fn(async () => jsonResponse({ runId: 'run-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    vi.spyOn(location, 'reload').mockImplementation(reload);

    render(h(ResumePanel, { runId: 'run-1' }), root);
    const note = root.querySelector('input[type="text"]') as HTMLInputElement;
    setValue(note, 'try the other approach');
    const iterations = root.querySelector('input[type="number"]') as HTMLInputElement;
    setValue(iterations, '5');

    const resume = [...root.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('resume'),
    ) as HTMLButtonElement;
    await until(() => note.value !== '');
    resume.click();
    await until(() => fetchMock.mock.calls.length > 0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/runs/run-1/resume');
    expect(JSON.parse(init.body as string)).toEqual({ note: 'try the other approach', maxIterations: 5 });
    await until(() => reload.mock.calls.length > 0);
  });
});
