import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/proxy/config'
import { ModelRegistry } from '../../src/proxy/registry'
import { FusionRouter } from '../../src/proxy/router'
import { createApp } from '../../src/proxy/app'
import { callHandler } from './helpers'

const cfg = loadConfig({
  providers: { openai: { baseUrl: 'http://openai.proxy.test/v1' } },
  models: [{ id: 'test-model', routes: [{ provider: 'openai', model: 'gpt-4', weight: 1 }] }],
})

const MOCK_COMPLETION = {
  id: 'chatcmpl-app',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
}

function makeApp(routerOverride?: { route(req: unknown): Promise<unknown> }) {
  const registry = new ModelRegistry(cfg)
  if (routerOverride) {
    return createApp(registry, routerOverride as unknown as FusionRouter)
  }
  const fetch = async () => ({
    ok: true, status: 200,
    json: async () => MOCK_COMPLETION,
  }) as unknown as Response
  const router = new FusionRouter(registry, fetch, { rng: () => 0 })
  return createApp(registry, router)
}

describe('GET /health', () => {
  it('returns 200 with {"status":"ok"}', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'GET', '/health')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ status: string }>().status).toBe('ok')
  })
})

describe('GET /v1/models', () => {
  it('returns 200 with an OpenAI-shaped model list', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'GET', '/v1/models')
    expect(res.statusCode).toBe(200)
    const body = res.json<{ object: string; data: Array<{ id: string; object: string; owned_by: string }> }>()
    expect(body.object).toBe('list')
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.id).toBe('test-model')
    expect(body.data[0]?.object).toBe('model')
    expect(body.data[0]?.owned_by).toBe('model-fusion-proxy')
  })
})

describe('POST /v1/chat/completions', () => {
  const VALID_BODY = {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello' }],
  }

  it('returns 200 with an OpenAI-shaped completion for a valid request', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', VALID_BODY)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ id: string; object: string; choices: unknown[] }>()
    expect(body.object).toBe('chat.completion')
    expect(body.id).toBeTruthy()
    expect(body.choices.length).toBeGreaterThan(0)
  })

  it('returns 400 with error envelope for missing model field', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.statusCode).toBe(400)
    const body = res.json<{ error: { message: string; type: string } }>()
    expect(body.error).toBeDefined()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('returns 400 for empty messages array', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', {
      model: 'test-model',
      messages: [],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { type: string } }>().error.type).toBe('invalid_request_error')
  })

  it('returns 400 for an invalid message role', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', {
      model: 'test-model',
      messages: [{ role: 'unknown_role', content: 'hi' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { type: string } }>().error.type).toBe('invalid_request_error')
  })

  it('returns 400 for an empty model string', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', {
      model: '',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { type: string } }>().error.type).toBe('invalid_request_error')
  })

  it('returns 400 for completely non-JSON body', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', undefined)
    // No body at all or non-JSON should yield 400
    expect(res.statusCode).toBe(400)
  })

  it('returns 502 with upstream_error envelope when routing fails', async () => {
    const failRouter = {
      route: async (): Promise<never> => { throw new Error('all upstream routes failed') },
    }
    const handler = makeApp(failRouter)
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', VALID_BODY)
    expect(res.statusCode).toBe(502)
    const body = res.json<{ error: { type: string } }>()
    expect(body.error.type).toBe('upstream_error')
  })

  it('includes x-fusion-route response header on success', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/chat/completions', VALID_BODY)
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-fusion-route']).toBeTruthy()
  })
})

describe('unknown routes', () => {
  it('returns 404 with not_found error envelope for GET /unknown', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'GET', '/unknown')
    expect(res.statusCode).toBe(404)
    const body = res.json<{ error: { message: string; type: string } }>()
    expect(body.error).toBeDefined()
    expect(body.error.type).toBe('not_found')
  })

  it('returns 404 for POST to an unrecognised path', async () => {
    const handler = makeApp()
    const res = await callHandler(handler, 'POST', '/v1/unknown')
    expect(res.statusCode).toBe(404)
  })
})
