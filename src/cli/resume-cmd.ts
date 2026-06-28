import type { SessionId } from '../domain/ids';
import { codecFor, type AgentCli } from '../agent-cli/registry';

/**
 * Capability A — map a finished run's `(harness, sessionId)` to the way the user CONTINUES that
 * session in the underlying CLI's OWN interactive mode (`claude --resume <id>`, etc.). Pure: it
 * bridges the `HarnessChoice` name to the per-codec {@link AgentCliCodec.interactiveResume} hint and
 * fails soft to a typed `none` (read-only, never throws).
 *
 *  - `command`     — a printable interactive-resume command (+ an optional honest caveat).
 *  - `goaly-code`  — the SDK-native harness has NO external CLI to resume into; route the user to
 *                    Capability C (`goaly "<follow-up>" --from-run <id> --inherit-session`).
 *  - `none`        — no resumable session / unknown or session-less harness, with a reason.
 */
export type ResumeHint =
  | { readonly kind: 'command'; readonly command: string; readonly caveat?: string }
  | { readonly kind: 'goaly-code'; readonly runId: string }
  | { readonly kind: 'none'; readonly reason: string };

const CLI_HARNESSES: ReadonlySet<string> = new Set<AgentCli>(['claude', 'codex', 'droid', 'pi']);

/**
 * Build the resume hint. `harness` comes from the run-log header (or a `--harness` fallback for a log
 * written before the field existed); `sessionId` is the run's last real session id; `runId` is used
 * only to phrase the goaly-code → Capability C route.
 */
export function resumeHint(
  harness: string | undefined,
  sessionId: SessionId | undefined,
  runId: string,
): ResumeHint {
  if (harness === 'goaly-code') {
    // goaly-code is resumable, but only THROUGH goaly itself (it owns the session store) — Capability C.
    return { kind: 'goaly-code', runId };
  }
  if (sessionId === undefined) {
    return { kind: 'none', reason: 'no resumable session was recorded for this run' };
  }
  if (harness === undefined) {
    return {
      kind: 'none',
      reason: 'the run log does not record which harness produced it — pass --harness <name>',
    };
  }
  if (harness === 'fake') {
    return { kind: 'none', reason: 'the fake harness has no interactive session to resume' };
  }
  if (CLI_HARNESSES.has(harness)) {
    const hint = codecFor(harness as AgentCli).interactiveResume?.(sessionId);
    if (hint === undefined) {
      return { kind: 'none', reason: `the ${harness} harness exposes no interactive resume` };
    }
    return {
      kind: 'command',
      command: hint.command,
      ...(hint.caveat !== undefined ? { caveat: hint.caveat } : {}),
    };
  }
  return { kind: 'none', reason: `unknown harness: ${harness}` };
}

/**
 * Render a {@link ResumeHint} as the lines printed under "Continue this session:" (the
 * `runs resume-cmd` body and the end-of-run banner). `verbose` adds the typed "none" reason; the
 * banner stays quiet (returns no lines) when there is nothing useful to print.
 */
export function renderResumeHint(hint: ResumeHint, opts: { verbose?: boolean } = {}): string[] {
  switch (hint.kind) {
    case 'command': {
      const lines = [hint.command];
      if (hint.caveat !== undefined) lines.push(`  note: ${hint.caveat}`);
      return lines;
    }
    case 'goaly-code':
      return [
        '(goaly-code has no external CLI to resume into — continue through goaly)',
        `goaly "<follow-up goal>" --from-run ${hint.runId} --inherit-session --harness goaly-code`,
      ];
    case 'none':
      return opts.verbose === true ? [`(no resume command: ${hint.reason})`] : [];
  }
}
