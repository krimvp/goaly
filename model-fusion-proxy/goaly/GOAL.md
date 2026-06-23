# Goal — OpenRouter-like model fusion routing proxy

Build a **local model-fusion routing proxy** in this TypeScript project: an OpenAI-compatible HTTP
gateway that routes and "fuses" chat-completion requests across multiple upstream model providers,
so any OpenAI-compatible harness can point at it as a single model provider. It should mirror the
core concepts of OpenRouter.

The project is pre-scaffolded: ES modules, a strict `tsconfig.json`, `vitest` wired to `npm test`,
and `zod`/`typescript`/`@types/node` available. Use `node:http` (no web-framework dependency). All
behavior must be testable with **no network access** — upstream HTTP calls go through an **injectable
`fetch`** so tests pass a fake.

## What to build

### 1. OpenAI-compatible HTTP surface
A `createApp()` handler factory in `src/` that does **not** bind a port (so it is unit-testable), plus
a thin `src/main.ts` entrypoint that does `http.createServer(handler).listen(PORT)` (PORT from env,
default 8787). Endpoints:
- `GET /health` → `200 {"status":"ok"}`.
- `GET /v1/models` → `200 {"object":"list","data":[...]}`, one OpenAI-shaped entry per configured
  virtual model (`{id, object:"model", created, owned_by:"model-fusion-proxy"}`).
- `POST /v1/chat/completions` → validate an OpenAI-style body with `zod` (`model`: non-empty string;
  `messages`: non-empty array of `{role: system|user|assistant, content: string}`; optional
  `stream`, `temperature`, `max_tokens`). Route it (see below) and return an OpenAI-shaped
  `chat.completion` object built from the upstream response.
- Invalid body → `400`; unknown route → `404`; both using an OpenAI-style error envelope
  `{"error":{"message":..., "type":...}}` (`invalid_request_error` / `not_found`).

### 2. Config + model registry
A `zod` config schema and `loadConfig(input: string | object): Config` that **fails closed** on
invalid config (typed error, clear message). Shape:
```
{ providers: { [name]: { baseUrl: string, apiKeyEnv?: string } },
  models: [ { id: string, routes: [ { provider: string, model: string, weight?: number } ] } ] }
```
Reject: a model with zero routes, a route naming an unknown provider, a non-positive weight. A
`ModelRegistry` built from a `Config` exposes `listModels()`, `getRoutes(id)`, `getProvider(name)`.

### 3. Provider adapters
A `Provider` interface with a single OpenAI-compatible upstream adapter that, given a provider config,
an upstream model id, and an OpenAI chat-completions request, performs a `POST {baseUrl}/chat/completions`
via the **injected `fetch`** (Authorization from `apiKeyEnv` when set) and returns the parsed
OpenAI-shaped completion. Map upstream non-2xx / network errors into a typed `ProviderError`.

### 4. Fusion routing engine (the core)
A router that, given a requested virtual `model` id and the registry, selects among that model's
routes and dispatches via the provider adapter, supporting these policies:
- **Model-id selection** — resolve the requested id to its route list.
- **Weighted load-balancing** — pick a route by `weight` (injectable RNG so tests are deterministic).
- **Fallback chain** — on a `ProviderError` from the chosen route, try the remaining routes in order;
  only surface an error after **all** routes fail.
Return both the completion and which route/provider served it (surface the serving model via the
response `model` field and/or an `x-fusion-route` response header).

### 5. Resilience
- Per-route **timeout** (config or default) that aborts a slow upstream and counts as a route failure.
- **Provider cooldown**: after N consecutive failures a provider is skipped until a cooldown elapses
  (injectable clock for tests).
- Normalize every failure into the OpenAI error envelope; a total routing failure → `502` with
  `type:"upstream_error"`.

## Definition of done
- `npm test` (vitest) and `tsc --noEmit` both pass.
- Every feature above is covered by focused tests that use the **injected `fetch`/clock/RNG** — no
  real sockets, no real network, no real upstream.
- Small, typed, single-responsibility modules; OpenAI-shaped requests/responses/errors throughout.
- Update `README.md` to document the endpoints, the config format, and the routing policies.
