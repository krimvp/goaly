/**
 * Driver-side consumers of the streaming tap (issue #23). Two pure, fail-closed renderings of a
 * phase-tagged {@link AgentStreamEvent}: a compact human line for the `--stream` stderr view, and a
 * flat field bag for the structured logger. Both are observability only — the reducer stays pure
 * and nothing here is persisted to the replay log.
 */

import type { AgentStreamEvent, PhasedStreamSink, StreamPhase } from '../agent-cli/stream';
import type { LogFields } from '../log/logger';

const DEFAULT_MAX_LEN = 160;

/** Collapse whitespace and clip to `max` chars (with an ellipsis) so a line stays one terminal row. */
function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Render a tool-input payload (a string, or any JSON value) to a short preview string. */
function previewInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * Format one phase-tagged event as a single `[phase] …` line (newline-terminated). Tool-neutral —
 * every harness/LLM step renders through the same switch, so the live view is uniform across tools.
 */
export function renderStreamLine(
  phase: StreamPhase,
  event: AgentStreamEvent,
  maxLen = DEFAULT_MAX_LEN,
): string {
  const tag = `[${phase}]`;
  switch (event.kind) {
    case 'session':
      return `${tag} · session ${event.sessionId}\n`;
    case 'reasoning':
      return `${tag} 🤔 ${clip(event.text, maxLen)}\n`;
    case 'message':
      return `${tag} 💬 ${clip(event.text, maxLen)}\n`;
    case 'tool_use':
      return `${tag} → ${event.name}${event.input !== undefined ? ` ${clip(previewInput(event.input), maxLen)}` : ''}\n`;
    case 'tool_result': {
      const code = event.exitCode !== undefined ? `exit ${event.exitCode} ` : '';
      return `${tag} ← ${code}${clip(event.output, maxLen)}\n`;
    }
    case 'usage': {
      const parts = [
        event.inputTokens !== undefined ? `in=${event.inputTokens}` : '',
        event.outputTokens !== undefined ? `out=${event.outputTokens}` : '',
        event.cachedTokens !== undefined ? `cached=${event.cachedTokens}` : '',
        event.totalTokens !== undefined ? `total=${event.totalTokens}` : '',
      ].filter((p) => p.length > 0);
      return `${tag} 🧮 tokens ${parts.join(' ')}\n`;
    }
    case 'done':
      return `${tag} ✓ done (${event.status})\n`;
  }
}

/** Flatten a phase-tagged event into structured log fields for the diagnostics logger (debug). */
export function streamLogFields(phase: StreamPhase, event: AgentStreamEvent): LogFields {
  return { phase, ...event };
}

export type StreamRendererOptions = {
  /** Where formatted lines go. Default `process.stderr` (stdout carries the run outcome). */
  write?: (line: string) => void;
  /** Per-field character cap. */
  maxLen?: number;
};

/**
 * Build a {@link PhasedStreamSink} that writes the live human view to stderr. Fail-closed: a
 * throwing writer is swallowed so the live view can never crash a run.
 */
export function makeStreamRenderer(opts: StreamRendererOptions = {}): PhasedStreamSink {
  const write =
    opts.write ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  return (phase, event) => {
    try {
      write(renderStreamLine(phase, event, opts.maxLen));
    } catch {
      /* the live view is diagnostics — never let it take down the orchestrator */
    }
  };
}
