import type { ProviderConfig } from './config'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
}

export interface ChatCompletionChoice {
  index: number
  message: { role: string; content: string }
  finish_reason: string
}

export interface ChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class ProviderError extends Error {
  public readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

export async function callProvider(
  provider: ProviderConfig,
  upstreamModel: string,
  request: ChatCompletionRequest,
  fetchFn: FetchFn,
  signal?: AbortSignal,
): Promise<ChatCompletion> {
  const url = `${provider.baseUrl}/chat/completions`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (provider.apiKeyEnv) {
    const key = process.env[provider.apiKeyEnv]
    if (key) {
      headers['Authorization'] = `Bearer ${key}`
    }
  }

  const body = JSON.stringify({ ...request, model: upstreamModel })

  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal: signal ?? null,
    })
  } catch (err) {
    throw new ProviderError(err instanceof Error ? err.message : 'Network error')
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const errBody = (await response.json()) as { error?: { message?: string } }
      if (errBody.error?.message) message = errBody.error.message
    } catch {
      // ignore parse error
    }
    throw new ProviderError(message, response.status)
  }

  return (await response.json()) as ChatCompletion
}
