/**
 * Slice 0 deliverable: the read-only {@link LlmProvider} backed by an OpenAI-compatible
 * chat-completions endpoint, driven through the shared {@link LlmClient} transport. It lets the
 * judge / approver / compiler / planner steps reason over the working tree using ANY such endpoint —
 * with no coding CLI installed — selected by `--llm-provider openai`. It NEVER edits the tree: it
 * sends a single `[system?, user]` exchange with no tools, so it is structurally read-only (the same
 * guarantee the CLI providers get from their read-only argv dialect).
 *
 * It FAILS CLOSED (throws) when the endpoint returns no usable text (invariant #4) — a thrown LLM
 * step becomes a fail-closed verdict / veto upstream, never a fabricated green. The reported `usage`
 * maps cleanly onto goaly's token accounting (cleaner than CLIs, which often report nothing).
 */

import type { LlmCompletion, LlmProvider, LlmRequest } from './provider';
import type { LlmClient } from '../llm-client/openai-client';
import { isEmptyBreakdown } from '../domain/usage';
import type { ChatMessage } from '../llm-client/schema';

export class OpenAiLlmProvider implements LlmProvider {
  readonly name: string;
  readonly #client: LlmClient;
  readonly #model: string;

  constructor(opts: { client: LlmClient; model: string }) {
    this.#client = opts.client;
    this.#model = opts.model;
    this.name = `openai:${opts.model}`;
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const messages: ChatMessage[] = [
      ...(req.system !== undefined ? [{ role: 'system' as const, content: req.system }] : []),
      { role: 'user' as const, content: req.prompt },
    ];
    const result = await this.#client.chat({
      model: this.#model,
      messages,
      // Judging/approval must be as stable as possible; default to 0 like the CLI providers.
      temperature: req.temperature ?? 0,
    });
    const text = (result.content ?? '').trim();
    if (text.length === 0) {
      throw new Error(`OpenAI provider ${this.name} produced no text (finish: ${result.finishReason ?? 'none'})`);
    }
    const usage = result.usage;
    if (usage === undefined || usage.total === undefined) {
      return { text };
    }
    return {
      text,
      tokensUsed: usage.total,
      tokenSource: 'reported',
      // A breakdown belongs only to a reported count; omit an all-empty one.
      ...(isEmptyBreakdown(usage.breakdown) ? {} : { tokenBreakdown: usage.breakdown }),
    };
  }
}
