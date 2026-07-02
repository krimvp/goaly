import { h, type VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import type { RunsIndex, RunDetailResponse, WorktreesResponse, SseFrame, RootRef } from '../api-schema';
import type { RunLogEntry } from '../../runlog/runlog';
import { api, subscribeRunEvents } from './api';
import { feedLine, streamLine, fmtDate, statusBadgeClass, truncate, type FeedLine } from './format';

const html = htm.bind(h);

function rootLabel(root: RootRef): string {
  return root.kind === 'main' ? 'main workspace' : `worktree: ${root.name}`;
}

/** Poll a fetcher on an interval (the runs table's live badges without one SSE per row). */
function usePolled<T>(fetcher: () => Promise<T>, intervalMs: number): { data: T | undefined; error: string | undefined } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const tick = (): void => {
      fetcher().then(
        (d) => {
          if (alive) {
            setData(d);
            setError(undefined);
          }
        },
        (e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        },
      );
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return (): void => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { data, error };
}

// ---- runs table -------------------------------------------------------------

export function RunsPage(): VNode {
  const { data, error } = usePolled<RunsIndex>(() => api.runs(), 2000);
  if (error !== undefined) return html`<div class="error-box">${error}</div>` as VNode;
  if (data === undefined) return html`<div class="empty">loading…</div>` as VNode;
  const nonEmpty = data.roots.filter((r) => r.runs.length > 0);
  if (nonEmpty.length === 0) {
    return html`<div class="empty">
      No runs yet in this workspace. Start one from a terminal — e.g.
      <code>goaly "your goal" --verify-cmd "npm test"</code> — and it appears here live.
    </div>` as VNode;
  }
  return html`<div>
    ${nonEmpty.map(
      (group) => html`<section>
        <h2>${rootLabel(group.root)}</h2>
        <table class="list">
          <thead><tr><th>run</th><th>status</th><th>iters</th><th>tokens</th><th>started</th><th>goal</th></tr></thead>
          <tbody>
            ${group.runs.map((item) =>
              item.ok
                ? html`<tr class="row" onClick=${(): void => { location.hash = `#/runs/${item.summary.runId}`; }}>
                    <td class="mono">${item.summary.runId.slice(0, 12)}…</td>
                    <td>
                      <span class=${statusBadgeClass(item.summary.status)}>${item.summary.status}</span>
                      ${item.live ? html` <span class="badge live">LIVE</span>` : ''}
                    </td>
                    <td>${item.summary.iterations}</td>
                    <td>${item.summary.tokensSpent ?? '–'}</td>
                    <td class="mono">${fmtDate(item.summary.startedAt)}</td>
                    <td>${truncate(item.summary.goal, 80)}</td>
                  </tr>`
                : html`<tr>
                    <td class="mono">${item.runId}</td>
                    <td><span class="badge corrupt">CORRUPT</span></td>
                    <td colspan="4" class="muted">${truncate(item.error, 100)}</td>
                  </tr>`,
            )}
          </tbody>
        </table>
      </section>`,
    )}
  </div>` as VNode;
}

// ---- run detail + live feed --------------------------------------------------

export function RunDetailPage({ runId }: { runId: string }): VNode {
  const [detail, setDetail] = useState<RunDetailResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<FeedLine[]>([]);
  const [live, setLive] = useState<boolean | undefined>(undefined);
  const iterations = useRef(0);
  const feedEl = useRef<HTMLDivElement | null>(null);

  const refetch = (): void => {
    api.run(runId).then(setDetail, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    refetch();
    iterations.current = 0;
    const unsubscribe = subscribeRunEvents(runId, (frame: SseFrame) => {
      if (frame.event === 'entry') {
        const entry = frame.data as RunLogEntry;
        if (entry.event.tag === 'AGENT_RAN') iterations.current += 1;
        const line = feedLine(entry, iterations.current);
        if (line !== null) setLines((prev) => [...prev, line]);
      } else if (frame.event === 'stream') {
        const line = streamLine(frame.data);
        if (line !== null) setLines((prev) => [...prev, line]);
      } else if (frame.event === 'liveness') {
        setLive(frame.data.live);
      } else if (frame.event === 'terminal') {
        setLive(false);
        refetch(); // pick up the final status / usage totals
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    feedEl.current?.scrollTo({ top: feedEl.current.scrollHeight });
  }, [lines]);

  if (error !== undefined) return html`<div class="error-box">${error}</div>` as VNode;
  if (detail === undefined) return html`<div class="empty">loading…</div>` as VNode;
  const d = detail.detail;
  return html`<div>
    <div class="card">
      <dl class="kv">
        <dt>run</dt><dd class="mono">${d.runId}</dd>
        <dt>status</dt><dd>
          <span class=${statusBadgeClass(d.status)}>${d.status}</span>
          ${(live ?? detail.live) ? html` <span class="badge live">LIVE</span>` : ''}
        </dd>
        <dt>goal</dt><dd>${d.goal}</dd>
        ${d.reason !== undefined ? html`<dt>reason</dt><dd>${d.reason}</dd>` : ''}
        <dt>where</dt><dd>${rootLabel(detail.root)}</dd>
        <dt>iterations</dt><dd>${d.iterations}</dd>
        <dt>tokens</dt><dd>${d.tokensSpent ?? 'unknown'}</dd>
        ${d.harness !== undefined ? html`<dt>harness</dt><dd>${d.harness}</dd>` : ''}
        <dt>resume</dt><dd class="mono">goaly --resume ${d.runId}</dd>
      </dl>
    </div>

    ${d.contract !== null
      ? html`<div class="card">
          <h2 style="margin-top:0">frozen contract <span class="mono muted">${d.contract.contractHash}</span></h2>
          ${d.contract.setup !== undefined ? html`<div class="muted">setup: <code>${d.contract.setup}</code></div>` : ''}
          <ol style="margin:0.4rem 0 0; padding-left:1.4rem">
            ${d.contract.rungs.map((rung) =>
              rung.kind === 'deterministic'
                ? html`<li>deterministic${rung.label !== undefined ? ` (${rung.label})` : ''}: <code>${rung.command}</code></li>`
                : html`<li>judge${rung.label !== undefined ? ` (${rung.label})` : ''}: quorum ${rung.quorum} — ${truncate(rung.rubric, 140)}</li>`,
            )}
          </ol>
          ${d.seal.length > 0 ? html`<div class="muted" style="margin-top:0.5rem">seal: ${d.seal.map((s) => s.kind).join(' → ')}</div>` : ''}
        </div>`
      : html`<div class="card muted">no contract yet (run ${d.status === 'INCOMPLETE' ? 'is still compiling' : 'failed before compile'})</div>`}

    ${d.iterationsDetail.length > 0
      ? html`<div class="card">
          <h2 style="margin-top:0">iterations</h2>
          ${d.iterationsDetail.map(
            (it) => html`<div class="iter">
              <div class="head">
                #${it.index}${it.phase !== undefined ? html` <span class="muted">(phase ${it.phase + 1})</span>` : ''}
                — agent ${it.runStatus}, ${it.changed ? 'tree changed' : 'no changes'}
              </div>
              ${it.verdict !== undefined
                ? html`<div class=${it.verdict.pass ? 'pass' : 'fail'} style=${`color: var(--${it.verdict.pass ? 'accent' : 'red'})`}>
                    verify ${it.verdict.pass ? 'PASS ✓' : 'FAIL ✗'}${it.verdict.pass ? '' : ` — ${truncate(it.verdict.detail, 200)}`}
                  </div>`
                : html`<div class="muted">verify: not reached</div>`}
              ${it.signoff !== undefined
                ? html`<div style=${`color: var(--${it.signoff.veto ? 'red' : 'accent'})`}>
                    sign-off ${it.signoff.veto ? `VETO — ${truncate(it.signoff.reason ?? '', 200)}` : 'approved'}
                  </div>`
                : ''}
            </div>`,
          )}
        </div>`
      : ''}

    <h2>live feed</h2>
    <div class="feed" ref=${feedEl}>
      ${lines.length === 0 ? html`<span class="muted">waiting for events…</span>` : ''}
      ${lines.map((l) => html`<div><span class="t">${l.at}</span>  <span class=${l.tone === 'plain' ? '' : l.tone}>${l.text}</span></div>`)}
    </div>
  </div>` as VNode;
}

// ---- worktrees panel ---------------------------------------------------------

export function WorktreesPage(): VNode {
  const { data, error } = usePolled<WorktreesResponse>(() => api.worktrees(), 5000);
  if (error !== undefined) return html`<div class="error-box">${error}</div>` as VNode;
  if (data === undefined) return html`<div class="empty">loading…</div>` as VNode;
  if (data.worktrees.length === 0) {
    return html`<div class="empty">
      No worktrees. Create one with <code>goaly worktree create ${'<name>'}</code> — or run with
      <code>--worktree ${'<name>'}</code> and it is created for you.
    </div>` as VNode;
  }
  return html`<table class="list">
    <thead><tr><th>name</th><th>branch</th><th>head</th><th>dirty</th><th>runs</th><th>path</th></tr></thead>
    <tbody>
      ${data.worktrees.map(
        (w) => html`<tr>
          <td>${w.name}</td>
          <td class="mono">${w.branch}</td>
          <td class="mono">${w.head}</td>
          <td>${w.prunable ? html`<span class="badge corrupt">PRUNABLE</span>` : w.dirty ? 'yes' : 'no'}</td>
          <td>${w.runs}</td>
          <td class="mono muted">${w.path}</td>
        </tr>`,
      )}
    </tbody>
  </table>` as VNode;
}
