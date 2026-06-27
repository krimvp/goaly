/**
 * Zod for the OpenAI-compatible chat-completions envelope — the wire seam of the goaly-code harness's
 * transport (invariant #6: parse at every seam). The REQUEST half is authored by goaly so it serves
 * mainly as the type source; the RESPONSE half is untrusted external data and is validated
 * fail-closed by the {@link ./openai-client.ts} before anything reaches the agent loop. Tolerant
 * where real OpenAI-compatible servers diverge (a missing tool-call `id`/`type`, `arguments` absent),
 * strict where a malformed shape must NOT be mistaken for a usable completion (no `choices`).
 */

import { z } from 'zod';
import type { TokenBreakdown } from '../domain/usage';

/** One assistant-requested function call. `arguments` is a JSON STRING (parsed per-tool downstream). */
export const ChatToolCall = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ChatToolCall = z.infer<typeof ChatToolCall>;

/**
 * A chat message in any of the four OpenAI roles. Persisted verbatim by the session store and
 * re-parsed on resume, so it is a Zod schema. An assistant turn may carry `tool_calls` and a `null`
 * content (a pure tool-calling turn); a `tool` message carries the result for one `tool_call_id`.
 */
export const ChatMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    tool_calls: z.array(ChatToolCall).optional(),
  }),
  z.object({ role: z.literal('tool'), content: z.string(), tool_call_id: z.string() }),
]);
export type ChatMessage = z.infer<typeof ChatMessage>;

/** A tool advertised to the model. `parameters` is a JSON-Schema object (opaque to us here). */
export const ChatTool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()),
  }),
});
export type ChatTool = z.infer<typeof ChatTool>;

/** The request body goaly POSTs. Authored internally; defined for type-safety + outgoing validation. */
export const ChatRequest = z.object({
  model: z.string(),
  messages: z.array(ChatMessage),
  tools: z.array(ChatTool).optional(),
  tool_choice: z.union([z.literal('auto'), z.literal('none'), z.literal('required')]).optional(),
  temperature: z.number().min(0).optional(),
  max_tokens: z.number().int().positive().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** Provider usage block. Tolerant: any field may be absent; extra fields pass through. */
export const ChatUsage = z
  .object({
    prompt_tokens: z.number().nonnegative().optional(),
    completion_tokens: z.number().nonnegative().optional(),
    total_tokens: z.number().nonnegative().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().nonnegative().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ChatUsage = z.infer<typeof ChatUsage>;

/**
 * A tool call as it comes back on a response choice — looser than {@link ChatToolCall}: real
 * OpenAI-compatible servers sometimes omit `id` or `type`, or send empty `arguments`. Normalized
 * into a strict {@link ChatToolCall} (a minted id, defaulted `''` args) by the client.
 */
export const ResponseToolCall = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string(), arguments: z.string().optional() }),
});
export type ResponseToolCall = z.infer<typeof ResponseToolCall>;

/**
 * The chat-completions response envelope. `choices` must be non-empty — an empty/absent choice set
 * is unusable and fails closed (a thrown completion becomes a `crashed` run / fail-closed verdict
 * upstream, never a fabricated green). Everything else is tolerant.
 */
export const ChatResponse = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                role: z.string().optional(),
                content: z.string().nullable().optional(),
                tool_calls: z.array(ResponseToolCall).optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: ChatUsage.optional(),
  })
  .passthrough();
export type ChatResponse = z.infer<typeof ChatResponse>;

/**
 * Map a provider `usage` block onto goaly's {@link TokenBreakdown} (per-category, the categories a
 * provider prices differently). OpenAI's `prompt_tokens` is INCLUSIVE of cached prompt tokens, so we
 * split them: `cacheRead` = cached, `input` = prompt − cached (never negative). `output` =
 * completion. A category is omitted (stays "unknown") rather than written as a silent zero.
 */
export function usageToBreakdown(usage: ChatUsage | undefined): TokenBreakdown {
  if (usage === undefined) return {};
  const cached = usage.prompt_tokens_details?.cached_tokens;
  const prompt = usage.prompt_tokens;
  const out: TokenBreakdown = {};
  if (prompt !== undefined) {
    const cachedN = cached ?? 0;
    out.input = Math.max(0, Math.trunc(prompt) - Math.trunc(cachedN));
  }
  if (usage.completion_tokens !== undefined) out.output = Math.trunc(usage.completion_tokens);
  if (cached !== undefined && cached > 0) out.cacheRead = Math.trunc(cached);
  return out;
}
