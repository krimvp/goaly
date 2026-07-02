import { h, render, type VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { api } from './api';
import { RunsPage, RunDetailPage, WorktreesPage } from './views';

const html = htm.bind(h);

/**
 * The goaly ui SPA root: a tiny hash router (#/runs, #/runs/:id, #/worktrees) over the read-only
 * API. State lives on the server's disk (the write-ahead logs); the client only renders it.
 */

type Route = { page: 'runs' } | { page: 'run'; runId: string } | { page: 'worktrees' };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const runMatch = /^runs\/([^/]+)$/.exec(path);
  if (runMatch !== null && runMatch[1] !== undefined) {
    return { page: 'run', runId: decodeURIComponent(runMatch[1]) };
  }
  if (path === 'worktrees') return { page: 'worktrees' };
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

function App(): VNode {
  const route = useRoute();
  const [version, setVersion] = useState('');
  useEffect(() => {
    api.version().then((v) => setVersion(v.version), () => setVersion(''));
  }, []);

  return html`<div class="shell">
    <header class="top">
      <h1><a href="#/runs">🎯 goaly</a></h1>
      <nav>
        <a href="#/runs" class=${route.page !== 'worktrees' ? 'active' : ''}>runs</a>
        <a href="#/worktrees" class=${route.page === 'worktrees' ? 'active' : ''}>worktrees</a>
      </nav>
      <span class="version">${version !== '' ? `v${version}` : ''}</span>
    </header>
    ${route.page === 'run'
      ? html`<${RunDetailPage} runId=${route.runId} key=${route.runId} />`
      : route.page === 'worktrees'
        ? html`<${WorktreesPage} />`
        : html`<${RunsPage} />`}
  </div>` as VNode;
}

const root = document.getElementById('app');
if (root !== null) render(html`<${App} />` as VNode, root);
