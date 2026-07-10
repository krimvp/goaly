import { h, render, type VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './api';
import type { RunsIndex } from '../api-schema';
import { RunsPage, RunDetailPage, WorktreesPage } from './views';
import { StartRunPage } from './views-interactive';

const html = htm.bind(h);

/**
 * The goaly control center SPA root: a tiny hash router (#/runs, #/runs/:id[/:tab], #/worktrees,
 * #/new) over the run-log API. State lives on the server's disk (the write-ahead logs); the
 * client only renders it.
 */

type RunTab = 'overview' | 'session' | 'feed';
type Route =
  | { page: 'runs' }
  | { page: 'run'; runId: string; tab: RunTab }
  | { page: 'worktrees' }
  | { page: 'new' };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const runMatch = /^runs\/([^/]+)(?:\/(session|feed))?$/.exec(path);
  if (runMatch !== null && runMatch[1] !== undefined) {
    const tab: RunTab = runMatch[2] === 'session' ? 'session' : runMatch[2] === 'feed' ? 'feed' : 'overview';
    return { page: 'run', runId: decodeURIComponent(runMatch[1]), tab };
  }
  if (path === 'worktrees') return { page: 'worktrees' };
  if (path === 'new') return { page: 'new' };
  return { page: 'runs' };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute(location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return (): void => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** The header's fleet lamp: how many runs are live right now, across every root. */
function useLiveCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      api.runs().then(
        (index: RunsIndex) => {
          if (!alive) return;
          let live = 0;
          for (const g of index.roots) for (const r of g.runs) if (r.ok && r.live) live += 1;
          setCount(live);
        },
        () => {},
      );
    };
    tick();
    const timer = setInterval(tick, 4000);
    return (): void => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return count;
}

function App(): VNode {
  const route = useRoute();
  const [version, setVersion] = useState('');
  const liveCount = useLiveCount();
  useEffect(() => {
    api.version().then((v) => setVersion(v.version), () => setVersion(''));
  }, []);

  return html`<div class="shell">
    <header class="top">
      <h1><a href="#/runs"><span class="brand-glyph">◎</span> goaly<span class="brand-sub">control center</span></a></h1>
      <nav>
        <a href="#/runs" class=${route.page === 'runs' || route.page === 'run' ? 'active' : ''}>missions</a>
        <a href="#/new" class=${route.page === 'new' ? 'active' : ''}>+ launch</a>
        <a href="#/worktrees" class=${route.page === 'worktrees' ? 'active' : ''}>worktrees</a>
      </nav>
      <div class="top-status">
        <span class=${`fleet-lamp${liveCount > 0 ? ' on' : ''}`} title=${`${liveCount} live run(s)`}>
          <span class="lamp-dot"></span>${liveCount > 0 ? `${liveCount} live` : 'idle'}
        </span>
        <span class="version">${version !== '' ? `v${version}` : ''}</span>
      </div>
    </header>
    ${route.page === 'run'
      ? html`<${RunDetailPage} runId=${route.runId} tab=${route.tab} key=${route.runId} />`
      : route.page === 'worktrees'
        ? html`<${WorktreesPage} />`
        : route.page === 'new'
          ? html`<${StartRunPage} />`
          : html`<${RunsPage} />`}
  </div>` as VNode;
}

const root = document.getElementById('app');
if (root !== null) render(html`<${App} />` as VNode, root);
