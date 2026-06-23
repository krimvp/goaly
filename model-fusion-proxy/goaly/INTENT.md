# Intent — how to author the verification for this goal

Author an **objective, in-repo, runnable** verification over the project's existing tooling. Do not
write a rubric that depends on runtime/visual behavior a grader cannot execute.

- The bar is the project's own test command: `npm test` (vitest, already wired). Author vitest test
  files under `test/` (or alongside `src/`) that import the proxy's modules directly.
- Tests MUST run with **no network access**. Exercise everything through the code's injectable seams:
  pass a **fake `fetch`** to the provider adapter / router, an **injectable clock** to the cooldown
  logic, and an **injectable RNG** to the weighted load-balancer. Never bind a real port or call a
  real upstream — drive `createApp()`'s handler directly (e.g. construct a fake `IncomingMessage`/
  `ServerResponse` or expose a pure `handle(request)` function) instead of opening a socket.
- Cover, at minimum: the OpenAI request/response/error shapes for each endpoint and the 400/404
  paths; config validation (a valid config plus each fail-closed rejection); the registry accessors;
  the provider adapter against a fake `fetch` (success + upstream-error mapping); the router's
  model-id resolution, deterministic weighted selection (seeded RNG), and fallback-on-failure
  (first route errors → next route serves); and resilience (timeout counts as a failure, provider
  cooldown skips a provider until the injected clock advances).
- Keep all helpers inside the workspace; do not reach outside the repo. Do not author a vacuous bar
  (`true`, `exit 0`) — the command must actually run the suite and fail when the behavior is wrong.
