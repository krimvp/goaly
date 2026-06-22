import type { SessionId } from '../domain/ids';
import type { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';
import type { AgentEventSink } from '../agent-cli/stream';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  defaultAgentExec,
  runCodecHarness,
  type AgentCliCodec,
  type AgentExecFn,
} from '../agent-cli/codec';

/**
 * The ONE codec-backed harness adapter (seam #1). Every coding-agent CLI is now a thin binding of
 * its {@link AgentCliCodec} — the per-CLI argv dialects, extractors, and status mapping all live in
 * the codec, so this generic adapter is all the harness wiring a new CLI needs: construct it with a
 * codec (and an optional `model` / `timeoutMs` / fake `exec`) and `run()` delegates to the shared
 * {@link runCodecHarness}. Adding a harness is one codec module + one registration line.
 */
export class AgentCliHarness implements HarnessAdapter {
  readonly name: string;
  readonly #codec: AgentCliCodec;
  readonly #exec: AgentExecFn;
  readonly #model: string | undefined;

  constructor(
    codec: AgentCliCodec,
    opts: { exec?: AgentExecFn; timeoutMs?: number; model?: string; cwd?: string } = {},
  ) {
    this.name = codec.name;
    this.#codec = codec;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    // `cwd` makes the agent run inside the workspace (seam #1). An injected `exec` (e.g. the sandbox
    // wrapper, which sets the jail's cwd itself) takes precedence and ignores it.
    this.#exec = opts.exec ?? defaultAgentExec(codec.command, timeoutMs, codec.promptOnStdin, opts.cwd);
    this.#model = opts.model;
  }

  run(prompt: string, sessionId?: SessionId, onEvent?: AgentEventSink): Promise<HarnessRunResult> {
    return runCodecHarness(this.#codec, this.#exec, this.#model, prompt, sessionId, onEvent);
  }
}
