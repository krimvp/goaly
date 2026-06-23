# model-fusion-proxy

An OpenRouter-like **model fusion routing proxy**: a local, OpenAI-compatible HTTP gateway that routes and fuses chat-completion requests across multiple upstream model providers. Point any OpenAI-compatible harness at it as a single endpoint.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{"status":"ok"}` |
| `GET` | `/v1/models` | List configured virtual models (OpenAI-shaped list) |
| `POST` | `/v1/chat/completions` | Route a chat completion request |

### POST /v1/chat/completions

Accepts an OpenAI-style request body:

```json
{
  "model": "my-virtual-model",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ],
  "temperature": 0.7,
  "max_tokens": 1024
}
```

Returns an OpenAI-shaped completion. On success, also sets the `x-fusion-route` response header to `<provider>/<upstream-model>` indicating which backend served the request.

**Errors:**
- `400` with `{"error":{"type":"invalid_request_error",...}}` — validation failure
- `404` with `{"error":{"type":"not_found",...}}` — unknown route
- `502` with `{"error":{"type":"upstream_error",...}}` — all routes failed

## Config format

```json
{
  "providers": {
    "openai": { "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
    "anthropic": { "baseUrl": "https://api.anthropic.com/v1", "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "models": [
    {
      "id": "fast",
      "routes": [{ "provider": "openai", "model": "gpt-4o-mini", "weight": 1 }]
    },
    {
      "id": "smart",
      "routes": [
        { "provider": "openai", "model": "gpt-4o", "weight": 2 },
        { "provider": "anthropic", "model": "claude-3-5-sonnet-20241022", "weight": 1 }
      ]
    }
  ]
}
```

**Validation rules:**
- Each model must have at least one route
- Each route's `provider` must reference a known provider name
- `weight` must be a positive number when provided (defaults to 1)
- `apiKeyEnv` names an environment variable holding the Bearer token

## Routing policies

### Weighted load-balancing

Routes are selected probabilistically by weight. Given routes `A(w=1)` and `B(w=3)`, route A is chosen 25% of the time and B 75%.

### Fallback chain

If the selected route fails (non-2xx, network error, or timeout), the proxy tries the remaining routes in config order. An error is surfaced only after all routes are exhausted.

### Per-route timeout

Each upstream call is guarded by a configurable timeout (default 30 s). A timeout counts as a route failure and triggers the fallback chain.

### Provider cooldown

After `cooldownFailureThreshold` consecutive failures (default 5), a provider enters a cooldown for `cooldownMs` (default 60 s). While in cooldown, the provider is skipped entirely — no fetch calls are made. Once the cooldown period expires, the provider is re-enabled and retried.

## Running

```sh
CONFIG_PATH=./config.json PORT=8787 npm start
```

## Testing

```sh
npm test      # vitest — zero real network, zero real sockets
```
