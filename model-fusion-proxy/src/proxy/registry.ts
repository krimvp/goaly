import type { Config, ProviderConfig, RouteConfig } from './config'

export interface ModelEntry {
  id: string
  object: 'model'
  created: number
  owned_by: 'model-fusion-proxy'
}

export class ModelRegistry {
  private readonly cfg: Config
  private readonly createdAt: number

  constructor(config: Config) {
    this.cfg = config
    this.createdAt = Math.floor(Date.now() / 1000)
  }

  listModels(): ModelEntry[] {
    return this.cfg.models.map((m) => ({
      id: m.id,
      object: 'model' as const,
      created: this.createdAt,
      owned_by: 'model-fusion-proxy' as const,
    }))
  }

  getRoutes(id: string): RouteConfig[] {
    const model = this.cfg.models.find((m) => m.id === id)
    if (!model) {
      throw new Error(`Unknown model id: "${id}"`)
    }
    return model.routes
  }

  getProvider(name: string): ProviderConfig {
    const p = this.cfg.providers[name]
    if (!p) {
      throw new Error(`Unknown provider: "${name}"`)
    }
    return p
  }
}
