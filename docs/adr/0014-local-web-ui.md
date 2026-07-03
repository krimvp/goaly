# ADR 0014 — a local web UI over the run log (`goaly ui`)

## Status
Accepted.

## Context

Operator control (ADR 0012) made runs observable and steerable from the terminal: `runs list/show`
replay the write-ahead log, `runs watch` tails it live, `--resume` extends. But the terminal view is
one-run-at-a-time and text-only. With named worktrees (ADR 0013) making *parallel* runs a normal
idiom, the operator increasingly wants a glanceable answer to "what is running, where, and how far
along is it?" — plus run history browsing that doesn't require remembering run ids.

Constraints that shaped the design:

1. **goaly's runtime dependency footprint is one package (zod)** — deliberately. A web framework
   (express, socket.io) or a UI framework in `dependencies` would be a real cost to every embedder.
2. **The write-ahead log is already the API.** ADR 0006/0012 built read-only projections
   (`listRuns`, `readRun`, the `runs watch` tail) whose outputs are exactly what a UI needs. Any
   server-side state beyond the disk would create a second source of truth that could drift.
3. **A localhost server with no auth is not private.** Any web page the operator's browser has open
   can issue requests to `127.0.0.1` (CSRF), and DNS rebinding defeats "it only binds localhost".
   Run logs contain goals, diffs, and file paths; later slices add routes that start runs — i.e.
   execute code. The guards are a correctness requirement, not hardening polish.

## Decision

### A `node:http` server over the existing projections — the disk stays the source of truth

`goaly ui` (`src/ui/`) serves JSON straight from `listRuns` / `readRun` / `readStreamTranscript`
and the worktree manager — the same pure replay-folds the CLI renders. The server holds **no run
state in memory**; stopping and restarting it is always safe and never affects a run. Roots are
enumerated as: the main workspace plus every managed worktree (per-workspace state, ADR 0013), so
parallel worktree runs appear in one view.

### Live tails are SSE over the same poll loop as `runs watch`

`GET /api/runs/:id/events` re-skins the `runsWatch` loop (500 ms poll of the torn-tail-tolerant
reader; never takes the run lock; terminal only when the LAST entry is terminal, so a
`RUN_EXTENDED`-revived run keeps streaming) into typed frames: `hello`, `entry`, `liveness`,
`stream` (the per-turn transcript, tailed incrementally by byte offset when the run records one),
`terminal`. SSE over WebSockets because the flow is strictly server→client, it needs no dependency,
and `EventSource` handles reconnection. One EventSource per open run view; the runs table polls
`/api/runs` instead of holding N streams (browsers cap ~6 connections per HTTP/1.1 origin).

### The frontend is preact + htm — as devDependencies, bundled to static assets

The SPA (`src/ui/web/`) uses htm tagged templates (no JSX, no tsconfig transform) and is bundled by
the existing esbuild script into `dist/ui/` as a self-contained browser bundle. **`dependencies`
stays `{ zod }`**: preact/htm are devDependencies inlined at build time; the node bundles never
import them, and the browser imports server types with `import type` only (no zod in the client).
Missing assets degrade to API-only mode with a build hint — presentation never blocks the server.

### Fail-closed request guards, even for reads

- Bind `127.0.0.1` only (never configurable to `0.0.0.0` in this slice).
- Reject any request whose `Host` is not local — the DNS-rebinding guard.
- Reject any request bearing a cross-site `Origin` — the CSRF guard, load-bearing once
  state-changing routes exist (ADR 0015) but enforced for reads too (run logs are sensitive).
- Run ids in paths parse against a strict schema that doubles as the path-traversal guard, and the
  static file server refuses to resolve outside the assets dir or serve unknown extensions.
- Corrupt run logs surface as flagged entries / `409` — never dropped, never a 200 pretending
  health (invariant #6).

## Alternatives considered

- **express/fastify + ws** — capable, but adds runtime dependencies for what `node:http` + SSE do
  in a few hundred lines here; rejected on the footprint constraint.
- **A server-side event push (fs.watch) instead of polling** — inotify semantics differ across
  platforms/containers and the 500 ms poll is already proven by `runs watch`; not worth the
  platform surface.
- **A TUI** — weaker for history browsing and diff-sized content, needs a TUI dependency; the API
  layer built here can back one later without redesign.
- **Central run index** — rejected; the per-workspace directory scan is the existing contract and
  fast enough at run-history scale.

## Consequences

- The UI is read-only in this slice; starting/steering runs from the browser is ADR 0015 (the
  interactive slice: in-process runs, a UI Seal gate, stop, resume) and rides these same guards.
- Runs recorded without `--stream-transcript` show the event feed but no per-turn tool calls —
  the run log is the always-present backbone; the transcript is opt-in enrichment.
- `git clean`-style caveats and per-worktree state semantics are inherited from ADR 0013.
