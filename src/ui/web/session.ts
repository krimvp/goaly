import { h, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import type { StreamTranscriptEntry } from '../../runlog/stream-transcript';
import { fmtTime, fmtTokens } from './format';

const html = htm.bind(h);

/**
 * The session inspector — "jump inside the session". Renders the durable stream transcript
 * (`stream.jsonl`, replayed + tailed over SSE) as a readable trace of the agent's actual turns:
 * assistant messages, reasoning, tool invocations with their inputs/results, token usage, and
 * turn boundaries — each tagged with the seam it came from (agent / judge / approver / …).
 * Pure rendering over the canonical tool-neutral taxonomy, identical across every harness.
 */

/** Cap what the DOM holds; the full transcript stays on disk (`stream.jsonl`). */
export const SESSION_RENDER_CAP = 1500;

const PHASE_LABELS: Record<string, string> = {
  agent: 'agent',
  plan: 'planner',
  compile: 'compiler',
  judge: 'judge',
  approve: 'approver',
  preflight: 'pre-flight',
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

/** Multi-line pretty JSON for tool inputs; falls back to String() for non-JSON payloads. */
function pretty(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

function ToolBlock({ entry, result }: { entry: Extract<StreamTranscriptEntry, { kind: 'tool_use' }>; result: Extract<StreamTranscriptEntry, { kind: 'tool_result' }> | undefined }): VNode {
  const failed = result?.isError === true;
  return html`<details class=${`sess-tool${failed ? ' failed' : ''}`}>
    <summary>
      <span class="glyph">⚒</span>
      <span class="tool-name">${entry.name}</span>
      ${entry.input !== undefined ? html`<span class="tool-peek">${peek(entry.input)}</span>` : ''}
      <span class=${`tool-state ${failed ? 'fail' : result !== undefined ? 'ok' : 'pending'}`}>
        ${failed ? 'error' : result !== undefined ? 'ok' : '…'}
      </span>
    </summary>
    ${entry.input !== undefined ? html`<pre class="tool-io">${pretty(entry.input)}</pre>` : ''}
    ${result !== undefined
      ? html`<pre class=${`tool-io result${failed ? ' fail' : ''}`}>${result.output.length > 0 ? result.output : '(empty result)'}</pre>`
      : ''}
  </details>` as VNode;
}

/** One-line preview of a tool input for the collapsed summary row. */
function peek(input: unknown): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}

/**
 * Pair each tool_use with its result. Ids match when present; otherwise results attach to the
 * nearest preceding unmatched tool_use in the same phase (the common single-tool-in-flight case).
 */
export function pairToolResults(
  entries: readonly StreamTranscriptEntry[],
): Map<number, Extract<StreamTranscriptEntry, { kind: 'tool_result' }>> {
  const paired = new Map<number, Extract<StreamTranscriptEntry, { kind: 'tool_result' }>>();
  const openById = new Map<string, number>();
  const openStack: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'tool_use') {
      if (entry.id !== undefined) openById.set(entry.id, index);
      openStack.push(index);
    } else if (entry.kind === 'tool_result') {
      let target: number | undefined;
      if (entry.id !== undefined && openById.has(entry.id)) {
        target = openById.get(entry.id);
        if (target !== undefined) openById.delete(entry.id);
        const at = target !== undefined ? openStack.indexOf(target) : -1;
        if (at !== -1) openStack.splice(at, 1);
      } else {
        target = openStack.pop();
      }
      if (target !== undefined && !paired.has(target)) paired.set(target, entry);
    }
  });
  return paired;
}

export type SessionFilters = { reasoning: boolean; tools: boolean; phases: Set<string> };

export function SessionView({
  entries,
  live,
  harness,
  sessionId,
}: {
  entries: StreamTranscriptEntry[];
  live: boolean;
  harness: string | undefined;
  sessionId: string | undefined;
}): VNode {
  const [showReasoning, setShowReasoning] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  // Stick to the bottom while the operator hasn't scrolled up (reading history must not fight
  // the tail); re-pin once they scroll back down.
  const onScroll = (): void => {
    const el = scroller.current;
    if (el === null) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = scroller.current;
    if (el !== null && pinned.current) el.scrollTo({ top: el.scrollHeight });
  }, [entries.length, showReasoning, showTools, phaseFilter]);

  const phases = [...new Set(entries.map((e) => e.phase))];
  const overflow = entries.length > SESSION_RENDER_CAP;
  const windowed = overflow ? entries.slice(entries.length - SESSION_RENDER_CAP) : entries;
  const results = pairToolResults(windowed);
  const consumedResults = new Set<StreamTranscriptEntry>(results.values());

  const visible = windowed
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => {
      if (phaseFilter !== null && entry.phase !== phaseFilter) return false;
      if (entry.kind === 'reasoning' && (!showReasoning || entry.text.trim().length === 0)) return false;
      if ((entry.kind === 'tool_use' || entry.kind === 'tool_result') && !showTools) return false;
      if (entry.kind === 'tool_result' && consumedResults.has(entry)) return false; // rendered inside its tool block
      if (entry.kind === 'message' && entry.text.trim().length === 0) return false;
      return true;
    });

  if (entries.length === 0) {
    return html`<div class="empty">
      <p>No session transcript for this run.</p>
      <p class="muted">
        Runs started from this UI always record one. For terminal runs, pass
        <code>--stream-transcript</code> to capture the agent's turns into
        <code>.goaly/&lt;runId&gt;/stream.jsonl</code>.
      </p>
    </div>` as VNode;
  }

  return html`<div class="session">
    <div class="sess-toolbar">
      <div class="sess-filters">
        <button class=${`chip${phaseFilter === null ? ' on' : ''}`} onClick=${(): void => setPhaseFilter(null)}>all seams</button>
        ${phases.map(
          (p) => html`<button class=${`chip phase-${p}${phaseFilter === p ? ' on' : ''}`}
            onClick=${(): void => setPhaseFilter(phaseFilter === p ? null : p)}>${phaseLabel(p)}</button>`,
        )}
      </div>
      <div class="sess-filters">
        <button class=${`chip${showTools ? ' on' : ''}`} onClick=${(): void => setShowTools(!showTools)}>⚒ tools</button>
        <button class=${`chip${showReasoning ? ' on' : ''}`} onClick=${(): void => setShowReasoning(!showReasoning)}>∴ thinking</button>
      </div>
      ${sessionId !== undefined
        ? html`<span class="sess-id mono" title="the harness session behind this run — resume it interactively in your terminal">
            ${harness !== undefined ? `${harness} ` : ''}session ${sessionId}
          </span>`
        : ''}
    </div>
    ${overflow ? html`<div class="muted sess-note">showing the last ${SESSION_RENDER_CAP} of ${entries.length} entries — the full transcript is in stream.jsonl</div>` : ''}
    <div class="sess-scroll" ref=${scroller} onScroll=${onScroll}>
      ${visible.map(({ entry, index }) => sessionBlock(entry, results.get(index)))}
      ${live ? html`<div class="sess-cursor"><span class="dot"></span> session live — streaming</div>` : ''}
    </div>
  </div>` as VNode;
}

function sessionBlock(
  entry: StreamTranscriptEntry,
  result: Extract<StreamTranscriptEntry, { kind: 'tool_result' }> | undefined,
): VNode | '' {
  const stamp = html`<span class="sess-ts">${fmtTime(entry.ts)}</span>`;
  const rail = `sess-block phase-${entry.phase}`;
  switch (entry.kind) {
    case 'session':
      return html`<div class=${`${rail} kind-meta`}>${stamp}<span class="sess-meta">▸ ${phaseLabel(entry.phase)} session ${entry.sessionId}</span></div>` as VNode;
    case 'message':
      return html`<div class=${`${rail} kind-message`}>${stamp}<div class="sess-text">${entry.text}</div></div>` as VNode;
    case 'reasoning':
      return html`<div class=${`${rail} kind-reasoning`}>${stamp}<div class="sess-text">∴ ${entry.text}</div></div>` as VNode;
    case 'tool_use':
      return html`<div class=${`${rail} kind-tool`}>${stamp}<${ToolBlock} entry=${entry} result=${result} /></div>` as VNode;
    case 'tool_result':
      // An orphan result (its tool_use fell outside the render window) still shows.
      return html`<div class=${`${rail} kind-tool`}>${stamp}<pre class=${`tool-io result${entry.isError === true ? ' fail' : ''}`}>${entry.output}</pre></div>` as VNode;
    case 'usage':
      return entry.totalTokens !== undefined || entry.outputTokens !== undefined
        ? (html`<div class=${`${rail} kind-meta`}>${stamp}<span class="sess-meta">◇ ${fmtTokens(entry.totalTokens ?? entry.outputTokens)} tokens</span></div>` as VNode)
        : '';
    case 'done':
      return html`<div class=${`${rail} kind-done`}>${stamp}<span class="sess-meta">■ turn done — ${entry.status}</span></div>` as VNode;
  }
}
