/**
 * An INTERNAL seam — deliberately NOT one of the four real seams. The LLM provider varies
 * *inside* the judge/approver/compiler, not across the Verifier/Approver interfaces, so it
 * never leaks through them (ARCHITECTURE: "don't leak internal seams through the interface").
 */
export type LlmRequest = {
  system?: string;
  prompt: string;
  /** Default 0 — judging/approval must be as stable as possible. */
  temperature?: number;
};

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}

/** Scripted provider for tests. Cycles through canned responses; repeats the last one. */
export class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  #i = 0;
  readonly #responses: string[];
  readonly requests: LlmRequest[] = [];
  constructor(responses: string[]) {
    this.#responses = responses;
  }
  async complete(req: LlmRequest): Promise<string> {
    this.requests.push(req);
    const r = this.#responses[this.#i] ?? this.#responses[this.#responses.length - 1];
    this.#i += 1;
    if (r === undefined) throw new Error('FakeLlm has no responses scripted');
    return r;
  }
}
