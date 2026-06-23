import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/proxy/config'
import { ModelRegistry } from '../../src/proxy/registry'

const cfg = loadConfig({
  providers: {
    a: { baseUrl: 'http://a.example.com' },
    b: { baseUrl: 'http://b.example.com', apiKeyEnv: 'B_KEY' },
  },
  models: [
    { id: 'model-x', routes: [{ provider: 'a', model: 'upstream-x', weight: 1 }] },
    {
      id: 'model-y',
      routes: [
        { provider: 'a', model: 'upstream-a', weight: 2 },
        { provider: 'b', model: 'upstream-b', weight: 1 },
      ],
    },
  ],
})

describe('ModelRegistry', () => {
  const reg = new ModelRegistry(cfg)

  it('listModels returns one entry per configured virtual model', () => {
    const models = reg.listModels()
    expect(models).toHaveLength(2)
  })

  it('listModels entries have object="model"', () => {
    for (const m of reg.listModels()) {
      expect(m.object).toBe('model')
    }
  })

  it('listModels entries have owned_by="model-fusion-proxy"', () => {
    for (const m of reg.listModels()) {
      expect(m.owned_by).toBe('model-fusion-proxy')
    }
  })

  it('listModels entries have numeric created timestamp', () => {
    for (const m of reg.listModels()) {
      expect(typeof m.created).toBe('number')
    }
  })

  it('listModels includes all configured model ids', () => {
    const ids = reg.listModels().map((m) => m.id)
    expect(ids).toContain('model-x')
    expect(ids).toContain('model-y')
  })

  it('getRoutes returns routes for a known model', () => {
    const routes = reg.getRoutes('model-y')
    expect(routes).toHaveLength(2)
  })

  it('getRoutes returns correct provider and model fields', () => {
    const routes = reg.getRoutes('model-x')
    expect(routes[0]?.provider).toBe('a')
    expect(routes[0]?.model).toBe('upstream-x')
  })

  it('getRoutes throws for unknown model id', () => {
    expect(() => reg.getRoutes('does-not-exist')).toThrow()
  })

  it('getProvider returns provider config for a known name', () => {
    const p = reg.getProvider('b')
    expect(p.baseUrl).toBe('http://b.example.com')
    expect(p.apiKeyEnv).toBe('B_KEY')
  })

  it('getProvider throws for unknown provider name', () => {
    expect(() => reg.getProvider('unknown')).toThrow()
  })
})
