import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/proxy/config'

const VALID = {
  providers: {
    openai: { baseUrl: 'https://api.openai.com/v1' },
    anthropic: { baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_KEY' },
  },
  models: [
    { id: 'fast', routes: [{ provider: 'openai', model: 'gpt-3.5-turbo', weight: 1 }] },
    {
      id: 'smart',
      routes: [
        { provider: 'openai', model: 'gpt-4', weight: 2 },
        { provider: 'anthropic', model: 'claude-3', weight: 1 },
      ],
    },
  ],
}

describe('loadConfig', () => {
  it('accepts a valid config object', () => {
    const cfg = loadConfig(VALID)
    expect(cfg.providers['openai']?.baseUrl).toBe('https://api.openai.com/v1')
    expect(cfg.models).toHaveLength(2)
    expect(cfg.models[0]?.id).toBe('fast')
  })

  it('accepts a valid config as JSON string', () => {
    const cfg = loadConfig(JSON.stringify(VALID))
    expect(cfg.models[1]?.id).toBe('smart')
  })

  it('preserves apiKeyEnv when present', () => {
    const cfg = loadConfig(VALID)
    expect(cfg.providers['anthropic']?.apiKeyEnv).toBe('ANTHROPIC_KEY')
  })

  it('routes without explicit weight are valid', () => {
    const cfg = loadConfig({
      providers: { p: { baseUrl: 'http://p.example.com' } },
      models: [{ id: 'm', routes: [{ provider: 'p', model: 'x' }] }],
    })
    expect(cfg.models[0]?.id).toBe('m')
  })

  it('rejects a model with zero routes', () => {
    expect(() =>
      loadConfig({ ...VALID, models: [{ id: 'broken', routes: [] }] })
    ).toThrow()
  })

  it('rejects a route referencing an unknown provider', () => {
    expect(() =>
      loadConfig({
        ...VALID,
        models: [{ id: 'x', routes: [{ provider: 'nonexistent', model: 'm' }] }],
      })
    ).toThrow()
  })

  it('rejects a non-positive weight (zero)', () => {
    expect(() =>
      loadConfig({
        ...VALID,
        models: [{ id: 'x', routes: [{ provider: 'openai', model: 'm', weight: 0 }] }],
      })
    ).toThrow()
  })

  it('rejects a non-positive weight (negative)', () => {
    expect(() =>
      loadConfig({
        ...VALID,
        models: [{ id: 'x', routes: [{ provider: 'openai', model: 'm', weight: -1 }] }],
      })
    ).toThrow()
  })

  it('rejects an invalid JSON string', () => {
    expect(() => loadConfig('not valid json { }')).toThrow()
  })

  it('rejects config missing providers', () => {
    expect(() => loadConfig({ models: [] })).toThrow()
  })

  it('rejects config missing models', () => {
    expect(() => loadConfig({ providers: {} })).toThrow()
  })
})
