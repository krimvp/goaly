# Rubric — what "done" means for the model fusion routing proxy

A correct solution is an OpenAI-compatible local proxy that fuses requests across multiple upstream
providers. Judge against these observable properties (all verified by the authored vitest suite,
running with no network via injected seams):

1. **OpenAI-compatible surface.** `GET /health`, `GET /v1/models` (lists configured virtual models in
   OpenAI shape), and `POST /v1/chat/completions` exist. Valid bodies return an OpenAI-shaped
   `chat.completion`; invalid bodies return `400` and unknown routes `404`, both with an
   `{"error":{"message","type"}}` envelope. The HTTP handler is exercised without opening a real socket.
2. **Config + registry fail closed.** A zod config schema validates `{providers, models[ {id, routes[
   {provider, model, weight?} ]} ]}`; invalid configs (zero routes, unknown provider, non-positive
   weight) are rejected with a typed error, and a valid config yields a registry whose accessors work.
3. **Provider adapter via injected fetch.** The OpenAI-compatible upstream adapter posts to
   `{baseUrl}/chat/completions` through an injected `fetch`, parses the OpenAI response, and maps
   non-2xx/network failures to a typed `ProviderError` — proven with a fake `fetch`.
4. **Fusion routing.** The router resolves a virtual model id to its routes, performs deterministic
   weighted selection under a seeded RNG, and on a route failure falls back through the remaining
   routes in order, surfacing an error only when all routes fail. Which route served is observable.
5. **Resilience.** A per-route timeout aborts a slow upstream and counts as a route failure; a
   provider that fails repeatedly is put on cooldown and skipped until an injected clock advances; a
   total routing failure normalizes to a `502` OpenAI error envelope.

The verification must be ungameable: it runs the real suite over the real modules and fails when any
property above is wrong. Reject trivially-passing or network-dependent checks.
