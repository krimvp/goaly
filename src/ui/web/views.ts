import { h, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import type { RunsIndex, RunDetailResponse, WorktreesResponse, SseFrame, RootRef, PendingGate, ApiRunListItem } from '../api-schema';
import type { RunLogEntry } from '../../runlog/runlog';
import type { StreamTranscriptEntry } from '../../runlog/stream-transcript';
import { api, subscribeRunEvents } from './api';
import {
  feedLine,
  streamLine,
  fmtDate,
  fmtAgo,
  fmtDuration,
  fmtTokens,
  statusBadgeClass,
  truncate,
  pipelineStageOf,
  PIPELINE_STAGES,
  type FeedLine,
} from './format';
import { SealModal, ResumePanel } from './views-interactive';
import { SessionView } from './session';

const html = htm.bind(h);

function rootLabel(root: RootRef): string {
  return root.kind === 'main' ? 'main workspace' : `worktree · ${root.name}`;
}

/** Poll a fetcher on an interval (the run board's live badges without one SSE per row). */
function usePolled<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  refreshKey = 0,
): { data: T | undefined; error: string | undefined } {
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
  }, [refreshKey]);
  return { data, error };
}

/** A coarse ticking "now" so relative times / elapsed clocks stay honest without re-render storms. */
function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return (): void => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable (permissions) — the text is still selectable */
  }
}

function CopyButton({ text, label }: { text: string; label?: string }): VNode {
  const [copied, setCopied] = useState(false);
  return html`<button class="chip copy" title="copy to clipboard"
    onClick=${(): void => {
      void copyText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }}>${copied ? '✓ copied' : (label ?? 'copy')}</button>` as VNode;
}

// ---- dashboard ---------------------------------------------------------------

type Kpis = {
  live: number;
  gated: number;
  done: number;
  failed: number;
  incomplete: number;
  tokens: number | undefined;
  corrupt: number;
};

function computeKpis(index: RunsIndex): Kpis {
  const kpis: Kpis = { live: 0, gated: 0, done: 0, failed: 0, incomplete: 0, tokens: undefined, corrupt: 0 };
  for (const group of index.roots) {
    for (const item of group.runs) {
      if (!item.ok) {
        kpis.corrupt += 1;
        continue;
      }
      const s = item.summary;
      if (item.live) kpis.live += 1;
      if (item.live && (s.stateTag === 'AWAIT_SEAL' || s.stateTag === 'AWAIT_PLAN_SEAL')) kpis.gated += 1;
      if (s.status === 'DONE') kpis.done += 1;
      else if (s.status === 'FAILED' || s.status === 'ABORTED') kpis.failed += 1;
      else kpis.incomplete += 1;
      if (s.tokensSpent !== undefined) kpis.tokens = (kpis.tokens ?? 0) + s.tokensSpent;
    }
  }
  return kpis;
}

function stateChip(item: Extract<ApiRunListItem, { ok: true }>): VNode | '' {
  if (!item.live) return '';
  const tag = item.summary.stateTag;
  const label =
    tag === 'AWAIT_SEAL' || tag === 'AWAIT_PLAN_SEAL'
      ? 'awaiting seal'
      : tag === 'RUNNING_AGENT' || tag === 'RUNNING_WAVE'
        ? 'agent working'
        : tag === 'VERIFYING'
          ? 'verifying'
          : tag === 'AWAIT_SIGNOFF'
            ? 'sign-off'
            : tag.toLowerCase().replace(/_/g, ' ');
  return html`<span class=${`state-chip${tag.startsWith('AWAIT') ? ' waiting' : ''}`}>${label}</span>` as VNode;
}

export function RunsPage(): VNode {
  const { data, error } = usePolled<RunsIndex>(() => api.runs(), 2000);
  const now = useNow();
  if (error !== undefined) return html`<div class="error-box">${error}</div>` as VNode;
  if (data === undefined) return html`<div class="empty">establishing link…</div>` as VNode;
  const kpis = computeKpis(data);
  const nonEmpty = data.roots.filter((r) => r.runs.length > 0);
  return html`<div>
    <div class="kpi-row">
      <div class=${`kpi${kpis.live > 0 ? ' hot' : ''}`}>
        <div class="kpi-label">live runs</div>
        <div class="kpi-value">${kpis.live}${kpis.live > 0 ? html`<span class="kpi-dot"></span>` : ''}</div>
      </div>
      <div class=${`kpi${kpis.gated > 0 ? ' warn' : ''}`}>
        <div class="kpi-label">awaiting seal</div>
        <div class="kpi-value">${kpis.gated}</div>
      </div>
      <div class="kpi good">
        <div class="kpi-label">done</div>
        <div class="kpi-value">${kpis.done}</div>
      </div>
      <div class=${`kpi${kpis.failed > 0 ? ' bad' : ''}`}>
        <div class="kpi-label">failed / aborted</div>
        <div class="kpi-value">${kpis.failed}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">tokens spent</div>
        <div class="kpi-value">${fmtTokens(kpis.tokens)}</div>
      </div>
    </div>

    ${nonEmpty.length === 0
      ? html`<div class="empty hero-empty">
          <div class="hero-glyph">◎</div>
          <p>No runs in this workspace yet.</p>
          <p class="muted">
            Launch one from <a href="#/new">the console</a> — or from any terminal:
            <code>goaly "your goal" --verify-cmd "npm test"</code>. It appears here live.
          </p>
        </div>`
      : nonEmpty.map(
          (group) => html`<section class="board-section">
            <h2>${rootLabel(group.root)}</h2>
            <div class="board">
              ${group.runs.map((item) =>
                item.ok
                  ? html`<a class=${`board-row${item.live ? ' live' : ''}`} href=${`#/runs/${encodeURIComponent(item.summary.runId)}`}>
                      <span class=${`stripe ${item.summary.status.toLowerCase()}${item.live ? ' pulsing' : ''}`}></span>
                      <span class="cell status">
                        <span class=${statusBadgeClass(item.summary.status)}>${item.summary.status}</span>
                        ${item.live ? html`<span class="badge live">LIVE</span>` : ''}
                        ${stateChip(item)}
                      </span>
                      <span class="cell goal" title=${item.summary.goal}>${truncate(item.summary.goal, 110)}</span>
                      <span class="cell metric mono" title="iterations">${item.summary.iterations}<span class="unit"> iter</span></span>
                      <span class="cell metric mono" title="tokens spent">${fmtTokens(item.summary.tokensSpent)}<span class="unit"> tok</span></span>
                      <span class="cell when mono" title=${fmtDate(item.summary.startedAt)}>${fmtAgo(item.summary.startedAt, now)}</span>
                      <span class="cell id mono">${item.summary.runId.slice(0, 10)}</span>
                    </a>`
                  : html`<div class="board-row corrupt-row">
                      <span class="stripe corrupt"></span>
                      <span class="cell status"><span class="badge corrupt">CORRUPT</span></span>
                      <span class="cell goal muted">${truncate(item.error, 110)}</span>
                      <span class="cell id mono">${item.runId.slice(0, 10)}</span>
                    </div>`,
              )}
            </div>
          </section>`,
        )}
  </div>` as VNode;
}

// ---- run detail: the mission view ---------------------------------------------

function Pipeline({ stateTag, status, live }: { stateTag: string; status: string; live: boolean }): VNode {
  const active = pipelineStageOf(stateTag);
  const activeIndex = PIPELINE_STAGES.findIndex((s) => s.key === active);
  const failed = status === 'FAILED' || status === 'ABORTED';
  return html`<div class=${`pipeline${failed ? ' failed' : ''}`}>
    ${PIPELINE_STAGES.map((stage, i) => {
      const isLoop = stage.key === 'agent' || stage.key === 'verify' || stage.key === 'signoff';
      const state =
        active === stage.key
          ? active === 'done'
            ? 'reached'
            : live
              ? 'active'
              : 'parked'
          : activeIndex !== -1 && i < activeIndex
            ? 'past'
            : 'pending';
      return html`${i > 0 ? html`<span class=${`pipe-link${activeIndex !== -1 && i <= activeIndex ? ' lit' : ''}`}></span>` : ''}
        <span class=${`pipe-node ${state}${isLoop ? ' loop' : ''}`} title=${isLoop ? 'the iteration loop' : ''}>
          <span class="pipe-dot"></span>
          <span class="pipe-label">${stage.label}</span>
        </span>`;
    })}
    ${failed ? html`<span class="pipe-terminal fail">✕ ${status}</span>` : ''}
  </div>` as VNode;
}

type RunTab = 'overview' | 'session' | 'feed';

export function RunDetailPage({ runId, tab }: { runId: string; tab: RunTab }): VNode {
  const [detail, setDetail] = useState<RunDetailResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<FeedLine[]>([]);
  const [stream, setStream] = useState<StreamTranscriptEntry[]>([]);
  const [live, setLive] = useState<boolean | undefined>(undefined);
  const [stateTag, setStateTag] = useState<string | undefined>(undefined);
  const [gate, setGate] = useState<PendingGate | null>(null);
  const [stopping, setStopping] = useState(false);
  const iterations = useRef(0);
  const now = useNow(1000);

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
        setStateTag(entry.stateTagAfter);
        const line = feedLine(entry, iterations.current);
        if (line !== null) setLines((prev) => [...prev, line]);
        if (entry.event.tag === 'CONTRACT_COMPILED' || entry.event.tag === 'SEAL_DECIDED' || entry.event.tag === 'VERIFIED') refetch();
      } else if (frame.event === 'stream') {
        setStream((prev) => [...prev, frame.data]);
        const line = streamLine(frame.data);
        if (line !== null) setLines((prev) => [...prev, line]);
      } else if (frame.event === 'liveness') {
        setLive(frame.data.live);
      } else if (frame.event === 'gate') {
        setGate(frame.data);
      } else if (frame.event === 'gate-resolved') {
        setGate(null);
      } else if (frame.event === 'terminal') {
        setLive(false);
        setGate(null);
        setStopping(false);
        setStateTag(frame.data.stateTag);
        refetch(); // pick up the final status / usage totals
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const stop = async (): Promise<void> => {
    setActionError(undefined);
    try {
      await api.stopRun(runId);
      setStopping(true); // cooperative: the ABORTED lands in the feed when the step finishes
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error !== undefined) return html`<div class="error-box">${error}</div>` as VNode;
  if (detail === undefined) return html`<div class="empty">establishing link…</div>` as VNode;
  const d = detail.detail;
  const isLive = live ?? detail.live;
  const tag = stateTag ?? d.stateTag;
  const elapsed = fmtDuration(d.startedAt, isLive ? now : (d.endedAt ?? d.startedAt));
  const budget = d.usage.budget;

  const tabLink = (t: RunTab, label: string, extra?: VNode | VNode[] | ''): VNode =>
    html`<a class=${`tab${tab === t ? ' on' : ''}`}
      href=${`#/runs/${encodeURIComponent(runId)}${t === 'overview' ? '' : `/${t}`}`}>${label}${extra ?? ''}</a>` as VNode;

  return html`<div class="mission">
    ${gate !== null
      ? html`<${SealModal}
          runId=${runId}
          gate=${gate}
          key=${gate.gateId}
          onResolved=${(gateId: string): void =>
            // Clear ONLY the answered gate: after a revise, the re-presented contract's NEW gate
            // frame can arrive over SSE before the POST response — it must not be clobbered.
            setGate((prev) => (prev !== null && prev.gateId === gateId ? null : prev))}
        />`
      : ''}
    ${actionError !== undefined ? html`<div class="error-box">${actionError}</div>` : ''}

    <div class="mission-head">
      <div class="mission-title">
        <div class="mission-goal">${d.goal}</div>
        <div class="mission-badges">
          <span class=${statusBadgeClass(d.status)}>${d.status}</span>
          ${isLive ? html`<span class="badge live">LIVE</span>` : ''}
          ${gate !== null ? html`<span class="badge incomplete">AWAITING SEAL</span>` : ''}
          <span class="muted where">${rootLabel(detail.root)}</span>
          <span class="mono muted where">${d.runId}</span>
        </div>
      </div>
      ${isLive
        ? html`<button class="linkish danger" disabled=${stopping} onClick=${(): void => void stop()}>
            ${stopping ? 'stopping — finishing the current step…' : '■ stop run'}
          </button>`
        : ''}
    </div>

    <${Pipeline} stateTag=${tag} status=${d.status} live=${isLive} />

    <div class="stat-row">
      <div class="stat"><div class="stat-label">iterations</div><div class="stat-value">${d.iterations}</div></div>
      <div class="stat">
        <div class="stat-label">tokens${budget.tokens !== undefined ? ' / budget' : ''}</div>
        <div class="stat-value">${fmtTokens(d.tokensSpent)}${budget.tokens !== undefined ? html`<span class="stat-sub"> / ${fmtTokens(budget.tokens)}</span>` : ''}</div>
        ${budget.tokens !== undefined
          ? html`<div class="meter"><span style=${`width:${Math.min(100, Math.round((budget.spent / budget.tokens) * 100))}%`} class=${budget.exceeded ? 'over' : ''}></span></div>`
          : ''}
      </div>
      <div class="stat"><div class="stat-label">${isLive ? 'elapsed' : 'duration'}</div><div class="stat-value">${elapsed}</div></div>
      <div class="stat"><div class="stat-label">harness</div><div class="stat-value small">${d.harness ?? '—'}</div></div>
      <div class="stat"><div class="stat-label">state</div><div class="stat-value small mono">${tag}</div></div>
    </div>

    ${d.reason !== undefined ? html`<div class="error-box"><b>${d.status.toLowerCase()}:</b> ${d.reason}</div>` : ''}

    <nav class="tabs">
      ${tabLink('overview', 'overview')}
      ${tabLink('session', 'session', stream.length > 0 ? html`<span class="tab-count">${stream.length}</span>` : '')}
      ${tabLink('feed', 'event feed')}
    </nav>

    ${tab === 'session'
      ? html`<${SessionView} entries=${stream} live=${isLive} harness=${d.harness} sessionId=${d.sessionId} />`
      : tab === 'feed'
        ? html`<${Feed} lines=${lines} live=${isLive} />`
        : html`<${Overview} detail=${detail} isLive=${isLive} runId=${runId} />`}
  </div>` as VNode;
}

function Overview({ detail, isLive, runId }: { detail: RunDetailResponse; isLive: boolean; runId: string }): VNode {
  const d = detail.detail;
  return html`<div>
    <div class="two-col">
      <div class="card">
        <h3>frozen contract</h3>
        ${d.contract !== null
          ? html`<div class="mono muted hash">⬡ ${d.contract.contractHash}</div>
              ${d.contract.setup !== undefined ? html`<div class="muted">setup: <code>${d.contract.setup}</code></div>` : ''}
              <ol class="ladder">
                ${d.contract.rungs.map((rung, i) =>
                  rung.kind === 'deterministic'
                    ? html`<li><span class="rung-kind det">R${i}</span><code>${rung.command}</code>${rung.label !== undefined ? html`<span class="muted"> · ${rung.label}</span>` : ''}</li>`
                    : html`<li><span class="rung-kind judge">R${i}</span>judge · quorum ${rung.quorum} — <span class="muted">${truncate(rung.rubric, 160)}</span></li>`,
                )}
              </ol>
              ${d.seal.length > 0 ? html`<div class="muted seal-trail">seal: ${d.seal.map((s) => s.kind).join(' → ')}</div>` : ''}
              <div class="two-keys">
                <span class="key">🔑 verifier ladder</span>
                <span class="key">🔑 sign-off approver</span>
                <span class="muted">— both must turn for DONE</span>
              </div>`
          : html`<div class="muted">no contract yet (${d.status === 'INCOMPLETE' ? 'still compiling' : 'the run ended before compile'})</div>`}
        ${d.compileFailures.length > 0
          ? html`<div class="muted">compile retries: ${d.compileFailures.length}</div>`
          : ''}
      </div>

      <div class="card">
        <h3>operate</h3>
        <div class="op-row">
          <span class="muted">resume in a terminal</span>
          <code class="mono">goaly --resume ${d.runId}</code>
          <${CopyButton} text=${`goaly --resume ${d.runId}`} />
        </div>
        ${d.sessionId !== undefined && d.harness === 'claude'
          ? html`<div class="op-row">
              <span class="muted">jump into the agent session</span>
              <code class="mono">claude --resume ${d.sessionId}</code>
              <${CopyButton} text=${`claude --resume ${d.sessionId}`} />
            </div>`
          : d.sessionId !== undefined
            ? html`<div class="op-row">
                <span class="muted">harness session</span>
                <code class="mono">${d.sessionId}</code>
                <${CopyButton} text=${d.sessionId} />
              </div>`
            : ''}
        <div class="op-row">
          <span class="muted">spend</span>
          <span>harness ${fmtTokens(d.usage.harness.tokens)} · llm steps ${fmtTokens(d.usage.llm.tokens)}
            ${d.usage.total.unknownCalls > 0 ? html`<span class="muted"> (+${d.usage.total.unknownCalls} unreported call${d.usage.total.unknownCalls === 1 ? '' : 's'})</span>` : ''}
          </span>
        </div>
        ${d.plan !== null
          ? html`<div class="op-row"><span class="muted">plan</span><span>${d.plan.phases.length} phases + acceptance</span></div>`
          : ''}
        ${!isLive && d.status !== 'DONE' ? html`<${ResumePanel} runId=${runId} />` : ''}
      </div>
    </div>

    ${d.iterationsDetail.length > 0
      ? html`<div class="card">
          <h3>iteration timeline</h3>
          <div class="timeline">
            ${d.iterationsDetail.map(
              (it) => html`<div class=${`t-item ${it.verdict === undefined ? '' : it.verdict.pass ? 'pass' : 'fail'}`}>
                <div class="t-marker mono">${it.index}</div>
                <div class="t-body">
                  <div class="t-head">
                    agent <b>${it.runStatus}</b> · ${it.changed ? 'tree changed' : 'no changes'}
                    ${it.phase !== undefined ? html`<span class="muted"> · phase ${it.phase + 1}</span>` : ''}
                    ${it.tokensSpent !== undefined ? html`<span class="muted mono"> · ${fmtTokens(it.tokensSpent)} tok</span>` : ''}
                  </div>
                  ${it.verdict !== undefined
                    ? html`<div class=${it.verdict.pass ? 'pass' : 'fail'}>
                        ${it.verdict.pass ? '✓ verify PASS' : `✗ verify FAIL — ${truncate(it.verdict.detail, 220)}`}
                      </div>`
                    : html`<div class="muted">verify not reached</div>`}
                  ${it.signoff !== undefined
                    ? html`<div class=${it.signoff.veto ? 'fail' : 'pass'}>
                        ${it.signoff.veto ? `⊘ sign-off VETO — ${truncate(it.signoff.reason ?? '', 220)}` : '✓ sign-off approved — both keys turned'}
                      </div>`
                    : ''}
                </div>
              </div>`,
            )}
          </div>
        </div>`
      : ''}
  </div>` as VNode;
}

function Feed({ lines, live }: { lines: FeedLine[]; live: boolean }): VNode {
  const feedEl = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const onScroll = (): void => {
    const el = feedEl.current;
    if (el === null) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = feedEl.current;
    if (el !== null && pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [lines]);
  return html`<div class="feed" ref=${feedEl} onScroll=${onScroll}>
    ${lines.length === 0 ? html`<span class="muted">waiting for events…</span>` : ''}
    ${lines.map((l) => html`<div><span class="t">${l.at}</span>  <span class=${l.tone === 'plain' ? '' : l.tone}>${l.text}</span></div>`)}
    ${live ? html`<div class="feed-cursor">▊</div>` : ''}
  </div>` as VNode;
}

// ---- worktrees panel ---------------------------------------------------------

export function WorktreesPage(): VNode {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error } = usePolled<WorktreesResponse>(() => api.worktrees(), 5000, refreshKey);
  const [newName, setNewName] = useState('');
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const create = async (event: Event): Promise<void> => {
    event.preventDefault();
    setActionError(undefined);
    try {
      await api.createWorktree(newName);
      setNewName('');
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (name: string, force: boolean): Promise<void> => {
    setActionError(undefined);
    try {
      await api.removeWorktree(name, { force });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      // The manager's refusal ladder (live run / dirty without force) surfaces verbatim.
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  if (error !== undefined) return html`<div class="error-box">${error}</div>` as VNode;
  if (data === undefined) return html`<div class="empty">establishing link…</div>` as VNode;
  return html`<div>
    <p class="muted lede">
      Isolated checkouts for parallel missions — each worktree runs its own goal without ever
      touching the main tree.
    </p>
    ${actionError !== undefined ? html`<div class="error-box" style="white-space:pre-wrap">${actionError}</div>` : ''}
    <form class="field-row wt-create" onSubmit=${create}>
      <input type="text" required placeholder="new worktree name" class="mono" value=${newName}
        onInput=${(e: Event): void => setNewName((e.target as HTMLInputElement).value)} />
      <button class="linkish primary" type="submit">+ create worktree</button>
    </form>
    ${data.worktrees.length === 0
      ? html`<div class="empty">
          No worktrees yet. Create one above — or start a run with the worktree option and it is
          created for you.
        </div>`
      : html`<table class="list">
          <thead><tr><th>name</th><th>branch</th><th>head</th><th>state</th><th>runs</th><th>path</th><th></th></tr></thead>
          <tbody>
            ${data.worktrees.map(
              (w) => html`<tr>
                <td><b>${w.name}</b></td>
                <td class="mono">${w.branch}</td>
                <td class="mono">${w.head}</td>
                <td>${w.prunable ? html`<span class="badge corrupt">PRUNABLE</span>` : w.dirty ? html`<span class="badge incomplete">DIRTY</span>` : html`<span class="badge done">CLEAN</span>`}</td>
                <td class="mono">${w.runs}</td>
                <td class="mono muted">${w.path}</td>
                <td>
                  <button class="linkish" onClick=${(): void => void remove(w.name, false)}>remove</button>
                  ${w.dirty ? html` <button class="linkish danger" onClick=${(): void => void remove(w.name, true)}>force</button>` : ''}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>`}
  </div>` as VNode;
}
