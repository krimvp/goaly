import { h, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import type {
  RunsIndex,
  RunDetailResponse,
  WorktreesResponse,
  SseFrame,
  RootRef,
  PendingGate,
  WorktreeChangesResponse,
  PrDraftRequest,
} from '../api-schema';
import type { RunLogEntry } from '../../runlog/runlog';
import { api, subscribeRunEvents } from './api';
import { feedLine, streamLine, fmtDate, statusBadgeClass, truncate, type FeedLine } from './format';
import { SealModal, ResumePanel } from './views-interactive';

const html = htm.bind(h);

function rootLabel(root: RootRef): string {
  return root.kind === 'main' ? 'main workspace' : `worktree: ${root.name}`;
}

/** Poll a fetcher on an interval (the runs table's live badges without one SSE per row). */
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
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<FeedLine[]>([]);
  const [live, setLive] = useState<boolean | undefined>(undefined);
  const [gate, setGate] = useState<PendingGate | null>(null);
  const [stopping, setStopping] = useState(false);
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
        if (entry.event.tag === 'CONTRACT_COMPILED' || entry.event.tag === 'SEAL_DECIDED') refetch();
      } else if (frame.event === 'stream') {
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

  useEffect(() => {
    feedEl.current?.scrollTo({ top: feedEl.current.scrollHeight });
  }, [lines]);

  if (error !== undefined) return html`<div class="error-box">${error}</div>` as VNode;
  if (detail === undefined) return html`<div class="empty">loading…</div>` as VNode;
  const d = detail.detail;
  const isLive = live ?? detail.live;
  return html`<div>
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
    <div class="card">
      <dl class="kv">
        <dt>run</dt><dd class="mono">${d.runId}</dd>
        <dt>status</dt><dd>
          <span class=${statusBadgeClass(d.status)}>${d.status}</span>
          ${isLive ? html` <span class="badge live">LIVE</span>` : ''}
          ${gate !== null ? html` <span class="badge incomplete">AWAITING SEAL</span>` : ''}
          ${isLive
            ? html` <button class="linkish danger" disabled=${stopping} onClick=${(): void => void stop()}>
                ${stopping ? 'stopping (finishing the current step)…' : 'stop'}
              </button>`
            : ''}
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

    ${!isLive && d.status !== 'DONE' ? html`<${ResumePanel} runId=${runId} />` : ''}

    ${!isLive
      ? html`<${LandingPanel} target=${detail.root} goal=${d.goal} harness=${d.harness} />`
      : ''}

    <h2>live feed</h2>
    <div class="feed" ref=${feedEl}>
      ${lines.length === 0 ? html`<span class="muted">waiting for events…</span>` : ''}
      ${lines.map((l) => html`<div><span class="t">${l.at}</span>  <span class=${l.tone === 'plain' ? '' : l.tone}>${l.text}</span></div>`)}
    </div>
  </div>` as VNode;
}

// ---- post-run landing panel (ADR 0017) ---------------------------------------

/**
 * Shown on a finished run: goaly's job ends at DONE, but the work still has to be shipped. Renders
 * the change set (files + diff) and the landing actions over the run's checkout. For a **worktree**
 * run the actions are commit / merge into main / open a PR over the `goaly/<name>` branch. For a
 * **main-workspace** run (no `--worktree`) there is no branch to PR into itself, so "open a PR"
 * ejects the changes onto a fresh `goaly/<name>` branch and returns you to your branch; merge is
 * not offered.
 */
export function LandingPanel({
  target,
  goal,
  harness,
}: {
  target: RootRef;
  goal?: string;
  harness?: string;
}): VNode {
  const isMain = target.kind === 'main';
  const [changes, setChanges] = useState<WorktreeChangesResponse | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [showDiff, setShowDiff] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [prBranch, setPrBranch] = useState(''); // main only: the goaly/<name> to eject onto
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prBase, setPrBase] = useState('');
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<VNode | string | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    try {
      setChanges(isMain ? await api.workspaceChanges() : await api.worktreeChanges(target.name));
      setLoadError(undefined);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, isMain ? '' : target.name]);

  // Wrap a landing action: single-flight (busy tag), reset messaging, refetch changes after.
  const act = (tag: string, fn: () => Promise<VNode | string>) => async (event?: Event): Promise<void> => {
    event?.preventDefault();
    setBusy(tag);
    setActionError(undefined);
    setNotice(undefined);
    try {
      setNotice(await fn());
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const commit = act('commit', async () => {
    const { head } = isMain
      ? await api.commitWorkspace(commitMsg)
      : await api.commitWorktree(target.name, commitMsg);
    setCommitMsg('');
    return `committed — new head ${head}`;
  });
  const merge = act('merge', async () => {
    if (isMain) return ''; // never rendered for main
    const { head } = await api.mergeWorktree(target.name, commitMsg !== '' ? { commitMessage: commitMsg } : {});
    return `merged into the main workspace (now at ${head})`;
  });
  const openPr = act('pr', async () => {
    if (isMain) {
      const { url, branch } = await api.openPrFromMain({
        name: prBranch,
        title: prTitle,
        ...(prBody !== '' ? { body: prBody } : {}),
        ...(prBase !== '' ? { base: prBase } : {}),
        ...(commitMsg !== '' ? { commitMessage: commitMsg } : {}),
      });
      return html`opened PR from <span class="mono">${branch}</span> — <a href=${url} target="_blank" rel="noopener noreferrer">${url}</a> (your workspace is back on <span class="mono">${changes?.branch}</span>)` as VNode;
    }
    const { url } = await api.openPr(target.name, {
      title: prTitle,
      ...(prBody !== '' ? { body: prBody } : {}),
      ...(prBase !== '' ? { base: prBase } : {}),
      ...(commitMsg !== '' ? { commitMessage: commitMsg } : {}),
    });
    return html`opened PR — <a href=${url} target="_blank" rel="noopener noreferrer">${url}</a>` as VNode;
  });

  // The agent drafts the PR title + body from the diff and fills the form; the human still reviews
  // and clicks "open PR" (publishing stays a deliberate human act).
  const draft = async (): Promise<void> => {
    setBusy('draft');
    setActionError(undefined);
    setNotice(undefined);
    try {
      const req = {
        ...(goal !== undefined ? { goal } : {}),
        ...(harness !== undefined ? { harness: harness as PrDraftRequest['harness'] } : {}),
      };
      const { title, body } = isMain ? await api.draftPrWorkspace(req) : await api.draftPr(target.name, req);
      setPrTitle(title);
      setPrBody(body);
      setNotice('the agent drafted the PR below — review and edit, then open it');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  if (loadError !== undefined) {
    return html`<div class="card"><h2 style="margin-top:0">landing</h2>
      <div class="muted">could not read the changes: ${loadError}</div></div>` as VNode;
  }
  if (changes === undefined) return html`<div class="card muted">loading changes…</div>` as VNode;

  const anyBusy = busy !== undefined;
  const where = isMain ? `main workspace, on ${changes.branch}` : changes.branch;
  return html`<div class="card">
    <h2 style="margin-top:0">landing <span class="mono muted">${where}</span></h2>
    <div class="muted" style="margin-bottom:0.5rem">
      goaly is done — this is the post-DONE step: ship the work. head ${changes.head} ·
      ${isMain
        ? html`${changes.ahead} unpushed commit${changes.ahead === 1 ? '' : 's'}`
        : html`${changes.ahead} commit${changes.ahead === 1 ? '' : 's'} ahead of main`} ·
      ${changes.dirty ? html`<strong>uncommitted changes present</strong>` : 'clean'}
    </div>

    ${changes.files.length === 0
      ? html`<div class="muted">no uncommitted changes here.</div>`
      : html`<div>
          <table class="list"><thead><tr><th>status</th><th>file</th></tr></thead>
            <tbody>
              ${changes.files.map(
                (f) => html`<tr><td class="mono">${f.status}</td><td class="mono">${f.path}</td></tr>`,
              )}
            </tbody>
          </table>
          ${changes.untracked > 0
            ? html`<div class="muted" style="margin-top:0.3rem">
                ${changes.untracked} new (untracked) file${changes.untracked === 1 ? '' : 's'} — content isn't in the
                diff below yet; it's included when you commit.
              </div>`
            : ''}
          ${changes.diff !== ''
            ? html`<div style="margin-top:0.4rem">
                <button class="linkish" onClick=${(): void => setShowDiff((v) => !v)}>
                  ${showDiff ? 'hide' : 'show'} diff
                </button>
                ${showDiff
                  ? html`<pre class="diff">${changes.diff}${changes.diffTruncated ? '\n… (diff truncated)' : ''}</pre>`
                  : ''}
              </div>`
            : ''}
        </div>`}

    ${actionError !== undefined ? html`<div class="error-box" style="margin-top:0.6rem">${actionError}</div>` : ''}
    ${notice !== undefined ? html`<div class="notice" style="margin-top:0.6rem">${notice}</div>` : ''}

    <div class="landing-actions" style="margin-top:0.8rem">
      <label class="muted">commit message (used by commit; and by ${isMain ? 'PR' : 'merge / PR'} when the tree is dirty)</label>
      <input type="text" class="mono" placeholder="goaly: ${isMain ? prBranch || 'work' : target.name}" value=${commitMsg}
        onInput=${(e: Event): void => setCommitMsg((e.target as HTMLInputElement).value)} />
      <div class="row" style="margin-top:0.5rem; gap:0.5rem; display:flex; flex-wrap:wrap">
        <button class="linkish primary" disabled=${anyBusy || commitMsg === ''} onClick=${(): void => void commit()}>
          ${busy === 'commit' ? 'committing…' : isMain ? `commit to ${changes.branch}` : 'commit'}
        </button>
        ${isMain
          ? ''
          : html`<button class="linkish" disabled=${anyBusy} onClick=${(): void => void merge()}>
              ${busy === 'merge' ? 'merging…' : 'merge into main'}
            </button>`}
      </div>

      <form onSubmit=${openPr} style="margin-top:0.8rem; border-top:1px solid var(--line); padding-top:0.6rem">
        <div style="display:flex; align-items:baseline; justify-content:space-between; gap:0.5rem; flex-wrap:wrap">
          <label class="muted">
            open a pull request${changes.canPr ? '' : ' (needs an origin remote + the gh CLI)'}
            ${isMain ? html`<br /><span style="font-size:0.85em">ejects your changes onto a new <span class="mono">goaly/&lt;name&gt;</span> branch, then returns you to <span class="mono">${changes.branch}</span></span>` : ''}
          </label>
          <button type="button" class="linkish" disabled=${anyBusy || changes.files.length === 0}
            title="let the agent write the title & body from the diff" onClick=${(): void => void draft()}>
            ${busy === 'draft' ? 'drafting…' : '✨ draft with the agent'}
          </button>
        </div>
        ${isMain
          ? html`<input type="text" class="mono" required placeholder="branch name (creates goaly/<name>)" value=${prBranch}
              onInput=${(e: Event): void => setPrBranch((e.target as HTMLInputElement).value)} />`
          : ''}
        <input type="text" required placeholder="PR title" value=${prTitle}
          onInput=${(e: Event): void => setPrTitle((e.target as HTMLInputElement).value)} />
        <textarea placeholder="PR body (optional)" rows="3" value=${prBody}
          onInput=${(e: Event): void => setPrBody((e.target as HTMLTextAreaElement).value)}></textarea>
        <input type="text" class="mono" placeholder=${isMain ? `base branch (optional — defaults to ${changes.branch})` : 'base branch (optional — defaults to the repo default)'} value=${prBase}
          onInput=${(e: Event): void => setPrBase((e.target as HTMLInputElement).value)} />
        <button class="linkish primary" type="submit" disabled=${anyBusy || !changes.canPr || prTitle === '' || (isMain && prBranch === '')}>
          ${busy === 'pr' ? 'opening PR…' : isMain ? 'create branch & open PR' : 'open PR'}
        </button>
      </form>
    </div>
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
  if (data === undefined) return html`<div class="empty">loading…</div>` as VNode;
  return html`<div>
    ${actionError !== undefined ? html`<div class="error-box" style="white-space:pre-wrap">${actionError}</div>` : ''}
    <form class="field-row" onSubmit=${create}>
      <input type="text" required placeholder="new worktree name" class="mono" value=${newName}
        onInput=${(e: Event): void => setNewName((e.target as HTMLInputElement).value)} />
      <button class="linkish primary" type="submit">create worktree</button>
    </form>
    ${data.worktrees.length === 0
      ? html`<div class="empty">
          No worktrees yet. Create one above — or start a run with the worktree option and it is
          created for you.
        </div>`
      : html`<table class="list">
          <thead><tr><th>name</th><th>branch</th><th>head</th><th>dirty</th><th>runs</th><th>path</th><th></th></tr></thead>
          <tbody>
            ${data.worktrees.map(
              (w) => html`<tr>
                <td>${w.name}</td>
                <td class="mono">${w.branch}</td>
                <td class="mono">${w.head}</td>
                <td>${w.prunable ? html`<span class="badge corrupt">PRUNABLE</span>` : w.dirty ? 'yes' : 'no'}</td>
                <td>${w.runs}</td>
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
