import type { LlmProvider } from '../llm/provider';
import { AgentCliLlmProvider } from '../llm/agent-cli-provider';
import { OpenAiLlmProvider } from '../llm/openai-provider';
import { OpenAiClient, type FetchLike } from '../llm-client/openai-client';
import { codecFor } from '../agent-cli/registry';
import type { AgentEventSink } from '../agent-cli/stream';
import type { LlmProviderChoice } from './args';

/**
 * The read-only LLM PROVIDER wiring: which concrete provider backs the workflow steps (judge /
 * approver / compiler / planner / observer) for a given `--llm-provider`, plus the shared
 * OpenAI-compatible transport the goaly-code harness reuses. Extracted from `compose.ts` so the
 * composition root stays about wiring seams together, not about each provider's construction.
 */

/**
 * Thrown when `--harness goaly-code` / `--llm-provider openai` is selected without the config they require
 * (a base URL, a resolved model). Fail-closed (invariant #4): the run refuses to start rather than
 * silently pointing at nothing. The CLI catches it for a friendly message + exit 2.
 */
export class EndpointConfigError extends Error {}

/**
 * Build the LLM provider for the workflow steps. `claude` uses the lean `claude -p` completion;
 * `codex`/`droid`/`pi` wrap their agentic CLI in a one-shot READ-ONLY mode (codex `--sandbox
 * read-only`, droid's default no-`--auto` exec, pi's `--tools read,grep,find,ls`) so a judge /
 * approver / compiler can use that tool's model without ever mutating the working tree it is judging.
 * The resolved per-step model is threaded in.
 */
export function makeLlmProvider(
  choice: LlmProviderChoice,
  model: string | undefined,
  opts: {
    onEvent?: AgentEventSink;
    timeoutMs?: number;
    baseUrl?: string;
    apiKey?: string;
    fetch?: FetchLike;
  } = {},
): LlmProvider {
  // `openai` is the first non-CLI provider: a direct chat-completions call (no coding CLI). It is
  // structurally read-only (one [system,user] exchange, no tools) and fails closed without the
  // endpoint/model it needs.
  if (choice === 'openai') {
    if (opts.baseUrl === undefined) {
      throw new EndpointConfigError('--llm-provider openai requires --base-url <url>');
    }
    if (model === undefined) {
      throw new EndpointConfigError('--llm-provider openai requires a model (--llm-model or --model)');
    }
    return new OpenAiLlmProvider({ client: makeOpenAiClient(opts.baseUrl, opts.apiKey, opts.timeoutMs, opts.fetch), model });
  }
  // One codec-driven provider for every CLI: the codec owns the read-only argv, the prompt-on-stdin
  // decision, and the field/stream extractors, so judge/approver/compiler share one source of truth
  // with the harness role. `claude` reads its prompt on stdin; codex/droid/pi carry it on argv —
  // the provider keys that off `codec.promptOnStdin`.
  return new AgentCliLlmProvider({
    codec: codecFor(choice),
    ...(model !== undefined ? { model } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
  });
}

/** Build the shared OpenAI-compatible HTTP client (transport for the provider AND the goaly-code harness). */
export function makeOpenAiClient(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number | undefined,
  fetch: FetchLike | undefined,
): OpenAiClient {
  return new OpenAiClient({
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(fetch !== undefined ? { fetch } : {}),
  });
}
