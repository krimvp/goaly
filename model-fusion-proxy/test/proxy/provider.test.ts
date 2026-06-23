import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { callProvider, ProviderError } from '../../src/proxy/provider'

const PROVIDER = { baseUrl: 'https://api.example.com/v1' }
const PROVIDER_WITH_KEY = { baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'TEST_PROXY_KEY' }

const REQUEST = {
  model: 'gpt-4',
  messages: [{ role: 'user' as const, content: 'Hello' }],
}

const MOCK_COMPLETION = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4',
  choices: [{
    index: 0,
    message: { role: 'assistant', content: 'Hi!' },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

describe('callProvider', () => {
  it('returns parsed completion on a 2xx response', async () => {
    const fetch = async () => makeResponse(200, MOCK_COMPLETION)
    const result = await callProvider(PROVIDER, 'gpt-4', REQUEST, fetch)
    expect(result.id).toBe('chatcmpl-test')
    expect(result.choices[0]?.message.content).toBe('Hi!')
  })

  it('posts to {baseUrl}/chat/completions', async () => {
    let capturedUrl = ''
    const fetch = async (url: string) => {
      capturedUrl = url
      return makeResponse(200, MOCK_COMPLETION)
    }
    await callProvider(PROVIDER, 'gpt-4', REQUEST, fetch)
    expect(capturedUrl).toContain('api.example.com')
    expect(capturedUrl).toContain('/chat/completions')
  })

  it('passes the upstream model id in the request body', async () => {
    let capturedBody = ''
    const fetch = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string ?? ''
      return makeResponse(200, MOCK_COMPLETION)
    }
    await callProvider(PROVIDER, 'upstream-model-id', REQUEST, fetch)
    expect(JSON.parse(capturedBody).model).toBe('upstream-model-id')
  })

  it('throws ProviderError on a non-2xx response', async () => {
    const fetch = async () => makeResponse(429, { error: { message: 'rate limited' } })
    await expect(callProvider(PROVIDER, 'gpt-4', REQUEST, fetch)).rejects.toBeInstanceOf(ProviderError)
  })

  it('ProviderError carries the upstream HTTP status', async () => {
    const fetch = async () => makeResponse(503, { error: { message: 'down' } })
    try {
      await callProvider(PROVIDER, 'gpt-4', REQUEST, fetch)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).status).toBe(503)
    }
  })

  it('throws ProviderError when fetch throws a network error', async () => {
    const fetch = async () => { throw new Error('ECONNREFUSED') }
    await expect(callProvider(PROVIDER, 'gpt-4', REQUEST, fetch)).rejects.toBeInstanceOf(ProviderError)
  })

  it('throws ProviderError when fetch is called with an aborted signal', async () => {
    const fetch = async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      await new Promise<never>(() => {})
      return makeResponse(200, MOCK_COMPLETION)
    }
    await expect(
      callProvider(PROVIDER, 'gpt-4', REQUEST, fetch, AbortSignal.abort())
    ).rejects.toBeInstanceOf(ProviderError)
  })

  describe('Authorization header', () => {
    beforeEach(() => { process.env['TEST_PROXY_KEY'] = 'sk-secret' })
    afterEach(() => { delete process.env['TEST_PROXY_KEY'] })

    it('includes Authorization header when apiKeyEnv is set', async () => {
      let capturedHeaders: Record<string, string> = {}
      const fetch = async (_url: string, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>
        return makeResponse(200, MOCK_COMPLETION)
      }
      await callProvider(PROVIDER_WITH_KEY, 'gpt-4', REQUEST, fetch)
      const auth = capturedHeaders['Authorization'] ?? capturedHeaders['authorization'] ?? ''
      expect(auth).toContain('sk-secret')
    })

    it('omits Authorization header when apiKeyEnv is not set', async () => {
      let capturedHeaders: Record<string, string> = {}
      const fetch = async (_url: string, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>
        return makeResponse(200, MOCK_COMPLETION)
      }
      await callProvider(PROVIDER, 'gpt-4', REQUEST, fetch)
      const auth = capturedHeaders['Authorization'] ?? capturedHeaders['authorization']
      expect(auth).toBeUndefined()
    })
  })
})
