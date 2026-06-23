import type { ModelRegistry } from './registry'
import type { ChatCompletionRequest, ChatCompletion, FetchFn } from './provider'
import { callProvider, ProviderError } from './provider'
import type { RouteConfig } from './config'

export interface RouteResult {
  completion: ChatCompletion
  provider: string
  model: string
}

interface ProviderState {
  consecutiveFailures: number
  cooldownUntil: number
}

export interface RouterOptions {
  rng?: () => number
  createTimeoutSignal?: (ms: number) => AbortSignal
  clock?: () => number
  cooldownFailureThreshold?: number
  cooldownMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_COOLDOWN_THRESHOLD = 5
const DEFAULT_COOLDOWN_MS = 60_000

export class FusionRouter {
  private readonly registry: ModelRegistry
  private readonly fetchFn: FetchFn
  private readonly rng: () => number
  private readonly createTimeoutSignal: (ms: number) => AbortSignal
  private readonly clock: () => number
  private readonly cooldownFailureThreshold: number
  private readonly cooldownMs: number
  private readonly providerState = new Map<string, ProviderState>()

  constructor(registry: ModelRegistry, fetchFn: FetchFn, opts: RouterOptions = {}) {
    this.registry = registry
    this.fetchFn = fetchFn
    this.rng = opts.rng ?? Math.random.bind(Math)
    this.createTimeoutSignal = opts.createTimeoutSignal ?? ((ms) => AbortSignal.timeout(ms))
    this.clock = opts.clock ?? (() => Date.now())
    this.cooldownFailureThreshold = opts.cooldownFailureThreshold ?? DEFAULT_COOLDOWN_THRESHOLD
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  private state(name: string): ProviderState {
    let s = this.providerState.get(name)
    if (!s) {
      s = { consecutiveFailures: 0, cooldownUntil: 0 }
      this.providerState.set(name, s)
    }
    return s
  }

  private isInCooldown(name: string): boolean {
    const s = this.state(name)
    return s.cooldownUntil > 0 && this.clock() < s.cooldownUntil
  }

  private recordFailure(name: string): void {
    const s = this.state(name)
    s.consecutiveFailures++
    if (s.consecutiveFailures >= this.cooldownFailureThreshold) {
      s.cooldownUntil = this.clock() + this.cooldownMs
    }
  }

  private recordSuccess(name: string): void {
    const s = this.state(name)
    s.consecutiveFailures = 0
    s.cooldownUntil = 0
  }

  private pickIndex(routes: RouteConfig[]): number {
    const total = routes.reduce((sum, r) => sum + (r.weight ?? 1), 0)
    const rand = this.rng() * total
    let cum = 0
    for (let i = 0; i < routes.length; i++) {
      cum += routes[i]!.weight ?? 1
      if (cum > rand) return i
    }
    return routes.length - 1
  }

  async route(request: ChatCompletionRequest): Promise<RouteResult> {
    const routes = this.registry.getRoutes(request.model)
    const primaryIdx = this.pickIndex(routes)

    // Primary route first, remaining in original order
    const ordered: RouteConfig[] = [
      routes[primaryIdx]!,
      ...routes.filter((_, i) => i !== primaryIdx),
    ]

    const errors: ProviderError[] = []

    for (const route of ordered) {
      if (this.isInCooldown(route.provider)) {
        errors.push(new ProviderError(`Provider "${route.provider}" is in cooldown`))
        continue
      }

      const signal = this.createTimeoutSignal(DEFAULT_TIMEOUT_MS)
      const provider = this.registry.getProvider(route.provider)

      try {
        const completion = await callProvider(provider, route.model, request, this.fetchFn, signal)
        this.recordSuccess(route.provider)
        return { completion, provider: route.provider, model: route.model }
      } catch (err) {
        if (err instanceof ProviderError) {
          this.recordFailure(route.provider)
          errors.push(err)
        } else {
          throw err
        }
      }
    }

    throw new ProviderError(
      `All routes failed: ${errors.map((e) => e.message).join('; ')}`,
    )
  }
}
