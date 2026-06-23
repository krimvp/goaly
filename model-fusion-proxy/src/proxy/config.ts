export interface ProviderConfig {
  baseUrl: string
  apiKeyEnv?: string
}

export interface RouteConfig {
  provider: string
  model: string
  weight?: number
}

export interface ModelConfig {
  id: string
  routes: RouteConfig[]
}

export interface Config {
  providers: Record<string, ProviderConfig>
  models: ModelConfig[]
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function validateProvider(raw: unknown, name: string): ProviderConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError(`Provider "${name}" must be an object`)
  }
  const p = raw as Record<string, unknown>
  const baseUrl = p['baseUrl']
  if (typeof baseUrl !== 'string' || !baseUrl) {
    throw new ConfigError(`Provider "${name}" must have a non-empty baseUrl string`)
  }
  const result: ProviderConfig = { baseUrl }
  const apiKeyEnv = p['apiKeyEnv']
  if (apiKeyEnv !== undefined) {
    if (typeof apiKeyEnv !== 'string') {
      throw new ConfigError(`Provider "${name}" apiKeyEnv must be a string`)
    }
    result.apiKeyEnv = apiKeyEnv
  }
  return result
}

function validateRoute(raw: unknown, modelId: string, idx: number, knownProviders: Set<string>): RouteConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError(`Model "${modelId}" route[${idx}] must be an object`)
  }
  const r = raw as Record<string, unknown>
  const provider = r['provider']
  const model = r['model']
  if (typeof provider !== 'string' || !provider) {
    throw new ConfigError(`Model "${modelId}" route[${idx}] must have a non-empty provider string`)
  }
  if (typeof model !== 'string' || !model) {
    throw new ConfigError(`Model "${modelId}" route[${idx}] must have a non-empty model string`)
  }
  if (!knownProviders.has(provider)) {
    throw new ConfigError(`Model "${modelId}" route[${idx}] references unknown provider "${provider}"`)
  }
  const route: RouteConfig = { provider, model }
  const weight = r['weight']
  if (weight !== undefined) {
    if (typeof weight !== 'number') {
      throw new ConfigError(`Model "${modelId}" route[${idx}] weight must be a number`)
    }
    if (weight <= 0) {
      throw new ConfigError(`Model "${modelId}" route[${idx}] weight must be positive, got ${weight}`)
    }
    route.weight = weight
  }
  return route
}

export function loadConfig(input: string | object): Config {
  let raw: unknown
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input)
    } catch {
      throw new ConfigError('Invalid JSON string')
    }
  } else {
    raw = input
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('Config must be an object')
  }
  const obj = raw as Record<string, unknown>

  if (!('providers' in obj)) {
    throw new ConfigError('Config must have a "providers" field')
  }
  if (!('models' in obj)) {
    throw new ConfigError('Config must have a "models" field')
  }

  const providersRaw = obj['providers']
  if (typeof providersRaw !== 'object' || providersRaw === null || Array.isArray(providersRaw)) {
    throw new ConfigError('"providers" must be a plain object')
  }
  const providers: Record<string, ProviderConfig> = {}
  for (const [name, pRaw] of Object.entries(providersRaw as Record<string, unknown>)) {
    providers[name] = validateProvider(pRaw, name)
  }
  const knownProviders = new Set(Object.keys(providers))

  const modelsRaw = obj['models']
  if (!Array.isArray(modelsRaw)) {
    throw new ConfigError('"models" must be an array')
  }
  const models: ModelConfig[] = []
  for (const mRaw of modelsRaw) {
    if (typeof mRaw !== 'object' || mRaw === null) {
      throw new ConfigError('Each model entry must be an object')
    }
    const m = mRaw as Record<string, unknown>
    const idRaw = m['id']
    if (typeof idRaw !== 'string' || !idRaw) {
      throw new ConfigError('Each model entry must have a non-empty id string')
    }
    const id: string = idRaw
    const routesRaw = m['routes']
    if (!Array.isArray(routesRaw)) {
      throw new ConfigError(`Model "${id}" must have a routes array`)
    }
    if (routesRaw.length === 0) {
      throw new ConfigError(`Model "${id}" must have at least one route`)
    }
    const routes = routesRaw.map((r: unknown, i: number) => validateRoute(r, id, i, knownProviders))
    models.push({ id, routes })
  }

  return { providers, models }
}
