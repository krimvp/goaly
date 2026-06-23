import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/proxy/config'
import { ModelRegistry } from '../../src/proxy/registry'
import { FusionRouter } from '../../src/proxy/router'

const cfg = loadConfig({
  providers: {
    fast: { baseUrl: 'http://fast.example.com/v1' },
    smart: { baseUrl: 'http://smart.example.com/v1' },
    third: { baseUrl: 'http://third.example.com/v1' },
  },
  models: [
    { id: 'single', routes: [{ provider: 'fast', model: 'fast-m', weight: 1 }] },
    {
      id: 'multi',
      routes: [
        { provider: 'fast', model: 'fast-m', weight: 1 },
        { provider: 'smart', model: 'smart-m', weight: 3 },
      ],
    },
    {
      id: 'triple',
      routes: [
        { provider: 'fast', model: 'fast-m', weight: 1 },
        { provider: 'smart', model: 'smart-m', weight: 1 },
        { provider: 'third', model: 'third-m', weight: 1 },
      ],
    },
  ],
})

const registry = new ModelRegistry(cfg)

const MOCK_COMPLETION = {
  id: 'chatcmpl-x',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
}

const REQ = { model: 'single', messages: [{ role: 'user' as const, content: 'hi' }] }

function okFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return async () => ({
    ok: true, status: 200,
    json: async () => MOCK_COMPLETION,
  }) as unknown as Response
}

function failFetch(status = 500): (url: string, init?: RequestInit) => Promise<Response> {
  return async () => ({
    ok: false, status,
    json: async () => ({ error: { message: 'upstream error' } }),
  }) as unknown as Response
}

describe('FusionRouter – model id resolution', () => {
  it('routes to the correct provider for a known model', async () => {
    const router = new FusionRouter(registry, okFetch(), { rng: () => 0 })
    const result = await router.route({ ...REQ, model: 'single' })
    expect(result.completion.id).toBe('chatcmpl-x')
  })

  it('exposes the serving provider name in the result', async () => {
    const router = new FusionRouter(registry, okFetch(), { rng: () => 0 })
    const result = await router.route({ ...REQ, model: 'single' })
    expect(result.provider).toBe('fast')
  })

  it('exposes the serving upstream model name in the result', async () => {
    const router = new FusionRouter(registry, okFetch(), { rng: () => 0 })
    const result = await router.route({ ...REQ, model: 'single' })
    expect(result.model).toBe('fast-m')
  })

  it('throws when the requested model id is not in the registry', async () => {
    const router = new FusionRouter(registry, okFetch(), { rng: () => 0 })
    await expect(router.route({ ...REQ, model: 'nonexistent' })).rejects.toThrow()
  })
})

describe('FusionRouter – weighted selection', () => {
  it('picks the first route when rng returns 0 (lowest weight bucket)', async () => {
    // multi: fast(w=1), smart(w=3) → total=4; rng=0 → 0*4=0 < 1 → fast
    const router = new FusionRouter(registry, okFetch(), { rng: () => 0 })
    const result = await router.route({ ...REQ, model: 'multi' })
    expect(result.provider).toBe('fast')
  })

  it('picks the second route when rng falls in the higher weight bucket', async () => {
    // rng=0.5 → 0.5*4=2 ≥ 1 → smart
    const router = new FusionRouter(registry, okFetch(), { rng: () => 0.5 })
    const result = await router.route({ ...REQ, model: 'multi' })
    expect(result.provider).toBe('smart')
  })

  it('is deterministic: same rng value → same route on every call', async () => {
    const router = new FusionRouter(registry, okFetch(), { rng: () => 0.99 })
    const r1 = await router.route({ ...REQ, model: 'multi' })
    const r2 = await router.route({ ...REQ, model: 'multi' })
    expect(r1.provider).toBe(r2.provider)
  })
})

describe('FusionRouter – fallback chain', () => {
  it('falls back to the next route when the chosen route fails', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      if (calls === 1) return { ok: false, status: 502, json: async () => ({}) } as unknown as Response
      return { ok: true, status: 200, json: async () => MOCK_COMPLETION } as unknown as Response
    }
    // rng=0 → picks fast first; fast fails; fallback to smart
    const router = new FusionRouter(registry, fetch, { rng: () => 0 })
    const result = await router.route({ ...REQ, model: 'multi' })
    expect(result.completion.id).toBe('chatcmpl-x')
    expect(calls).toBe(2)
  })

  it('throws only after all routes have been exhausted', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
    }
    const router = new FusionRouter(registry, fetch, { rng: () => 0 })
    await expect(router.route({ ...REQ, model: 'triple' })).rejects.toThrow()
    expect(calls).toBe(3)
  })

  it('surfaces an error when every route fails', async () => {
    const router = new FusionRouter(registry, failFetch(), { rng: () => 0 })
    await expect(router.route({ ...REQ, model: 'multi' })).rejects.toThrow()
  })
})

describe('FusionRouter – timeout resilience', () => {
  it('treats a timed-out route as a failure and falls back to the next', async () => {
    let calls = 0
    const fetch = async (_url: string, init?: RequestInit) => {
      calls++
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      return { ok: true, status: 200, json: async () => MOCK_COMPLETION } as unknown as Response
    }
    let signalCalls = 0
    const createTimeoutSignal = (_ms: number): AbortSignal => {
      signalCalls++
      return signalCalls === 1 ? AbortSignal.abort() : new AbortController().signal
    }
    // rng=0 picks fast first; fast's signal is immediately aborted → fallback to smart
    const router = new FusionRouter(registry, fetch, { rng: () => 0, createTimeoutSignal })
    const result = await router.route({ ...REQ, model: 'multi' })
    expect(result.completion.id).toBe('chatcmpl-x')
    expect(calls).toBe(2)
  })
})

describe('FusionRouter – provider cooldown', () => {
  it('stops calling a provider after it hits the failure threshold', async () => {
    let fetchCalls = 0
    const fetch = async () => {
      fetchCalls++
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
    }
    const router = new FusionRouter(registry, fetch, {
      rng: () => 0,
      clock: () => 0,
      cooldownFailureThreshold: 2,
      cooldownMs: 10000,
    })
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow() // failure 1
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow() // failure 2 → cooldown
    fetchCalls = 0
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow() // cooled down
    expect(fetchCalls).toBe(0) // provider skipped, no fetch call made
  })

  it('re-enables a provider once the clock advances past the cooldown period', async () => {
    let fetchCalls = 0
    const fetch = async () => {
      fetchCalls++
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
    }
    let now = 0
    const router = new FusionRouter(registry, fetch, {
      rng: () => 0,
      clock: () => now,
      cooldownFailureThreshold: 1,
      cooldownMs: 5000,
    })
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow() // 1 fail → cooldown
    fetchCalls = 0
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow() // skipped
    expect(fetchCalls).toBe(0)
    now = 5001 // advance clock past cooldown
    fetchCalls = 0
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow() // re-enabled
    expect(fetchCalls).toBe(1) // provider tried again
  })

  it('cooled-down provider is skipped; another provider on the same model serves', async () => {
    let calledUrls: string[] = []
    const fetch = async (url: string) => {
      calledUrls.push(url)
      if (url.includes('fast.example.com')) {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => MOCK_COMPLETION } as unknown as Response
    }
    const router = new FusionRouter(registry, fetch, {
      rng: () => 0,
      clock: () => 0,
      cooldownFailureThreshold: 2,
      cooldownMs: 60000,
    })
    // Exhaust fast provider via single (only route = fast)
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow()
    await expect(router.route({ ...REQ, model: 'single' })).rejects.toThrow()
    calledUrls = []
    // triple: fast cooled → skipped → smart or third serves
    const result = await router.route({ ...REQ, model: 'triple' })
    expect(result.completion.id).toBe('chatcmpl-x')
    expect(calledUrls.some((u) => u.includes('fast.example.com'))).toBe(false)
  })
})
