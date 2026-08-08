// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { render } from 'preact';
import type { RunsIndex, VersionResponse, WorktreesResponse } from '../api-schema';

/**
 * The SPA root: importing `./app` mounts the shell into `#app`, and the hash router swaps pages.
 * One mount for the whole file — the module renders as an import side effect, so tests share it
 * in hash-navigation order.
 */

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

async function until(cond: () => boolean): Promise<void> {
  await vi.waitFor(
    () => {
      if (!cond()) throw new Error('condition not met');
    },
    { timeout: 2000, interval: 5 },
  );
}

let root: HTMLElement;
const text = (): string => root.textContent ?? '';

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/version') return jsonResponse({ name: 'goaly', version: '9.9.9' } satisfies VersionResponse);
      if (url === '/api/runs') return jsonResponse({ roots: [] } satisfies RunsIndex);
      if (url === '/api/worktrees') return jsonResponse({ worktrees: [] } satisfies WorktreesResponse);
      return jsonResponse({});
    }),
  );
  root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  location.hash = '';
  await import('./app');
});

afterAll(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('app shell', () => {
  it('mounts the control center shell with nav and version', async () => {
    await until(() => text().includes('control center'));
    expect(text()).toContain('missions');
    expect(text()).toContain('worktrees');
    await until(() => text().includes('v9.9.9'));
    // default route is the run board
    await until(() => text().includes('No runs in this workspace yet'));
  });

  it('routes #/worktrees to the worktrees page on hashchange', async () => {
    location.hash = '#/worktrees';
    window.dispatchEvent(new Event('hashchange'));
    await until(() => text().includes('No worktrees yet'));
  });

  it('routes #/new to the launch console', async () => {
    location.hash = '#/new';
    window.dispatchEvent(new Event('hashchange'));
    await until(() => text().includes('launch a mission'));
  });

  it('falls back to the run board on an unknown route', async () => {
    location.hash = '#/nonsense';
    window.dispatchEvent(new Event('hashchange'));
    await until(() => text().includes('No runs in this workspace yet'));
  });
});
