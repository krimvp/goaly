// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { RunsPage, WorktreesPage } from './views';
import type { RunsIndex, WorktreesResponse } from '../api-schema';
import type { RunSummary } from '../../runlog/inspect';
import { RunId } from '../../domain/ids';

/**
 * The dashboard views, rendered for real under happy-dom against a stubbed `fetch`. These prove
 * each top-level view renders the API projections without throwing — KPI math, corrupt-row
 * fail-open rendering, and the worktree table — which is exactly the seam the server tests stop at.
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

/** Preact flushes effects on rAF and state on microtasks — poll until the DOM settles. */
async function until(cond: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if (!cond()) throw new Error('condition not met');
    },
    { timeout: 2000, interval: 5 },
  );
}

const text = (): string => root.textContent ?? '';

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: RunId.parse('run-dashboard-1'),
    goal: 'add a /health endpoint',
    status: 'DONE',
    stateTag: 'DONE',
    iterations: 2,
    tokensSpent: 1200,
    startedAt: Date.now() - 60_000,
    endedAt: Date.now(),
    contractHash: null,
    ...overrides,
  };
}

describe('RunsPage', () => {
  it('renders KPIs, live/ok rows, and corrupt rows from the index', async () => {
    const index: RunsIndex = {
      roots: [
        {
          root: { kind: 'main' },
          runs: [
            { ok: true, summary: summary(), live: false },
            {
              ok: true,
              summary: summary({ runId: RunId.parse('run-live-2'), status: 'INCOMPLETE', stateTag: 'RUNNING_AGENT' }),
              live: true,
            },
            { ok: false, runId: 'run-broken-3', error: 'header line unparsable' },
          ],
        },
        { root: { kind: 'worktree', name: 'feature-x' }, runs: [] },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(index)));

    render(h(RunsPage, {}), root);
    expect(text()).toContain('establishing link…');
    await until(() => text().includes('add a /health endpoint'));

    expect(text()).toContain('LIVE');
    expect(text()).toContain('agent working'); // the live RUNNING_AGENT state chip
    expect(text()).toContain('CORRUPT');
    expect(text()).toContain('header line unparsable');
    expect(text()).toContain('main workspace');
    expect(text()).not.toContain('worktree · feature-x'); // empty roots are not rendered
    // KPI row: 1 live, 1 done, 2.4k tokens total
    expect(text()).toContain('live runs');
    expect(text()).toContain('2.4k');
  });

  it('renders the hero empty state when no root has runs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ roots: [] } satisfies RunsIndex)));
    render(h(RunsPage, {}), root);
    await until(() => text().includes('No runs in this workspace yet'));
  });

  it('surfaces a fetch failure as the error box', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'state dir unreadable' }, 500)));
    render(h(RunsPage, {}), root);
    await until(() => text().includes('state dir unreadable'));
  });
});

describe('WorktreesPage', () => {
  it('renders the worktree table with state badges', async () => {
    const response: WorktreesResponse = {
      worktrees: [
        { name: 'clean-wt', path: '/tmp/wt/clean-wt', branch: 'goaly/clean-wt', head: 'abc1234', dirty: false, runs: 2, prunable: false },
        { name: 'dirty-wt', path: '/tmp/wt/dirty-wt', branch: 'goaly/dirty-wt', head: 'def5678', dirty: true, runs: 0, prunable: false },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(response)));
    render(h(WorktreesPage, {}), root);
    await until(() => text().includes('clean-wt'));

    expect(text()).toContain('CLEAN');
    expect(text()).toContain('DIRTY');
    // the dirty row offers force-remove, the clean one does not
    const forceButtons = [...root.querySelectorAll('button')].filter((b) => b.textContent === 'force');
    expect(forceButtons).toHaveLength(1);
  });

  it('submitting the create form POSTs and refreshes the list', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return jsonResponse({ name: 'new-wt' }, 201);
      return jsonResponse({ worktrees: [] } satisfies WorktreesResponse);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(h(WorktreesPage, {}), root);
    await until(() => root.querySelector('input[type="text"]') !== null);

    const input = root.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'new-wt';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => input.value === 'new-wt');
    const form = root.querySelector('form');
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'));

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/worktrees');
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ name: 'new-wt' });
  });
});
