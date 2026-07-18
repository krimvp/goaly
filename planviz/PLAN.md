# PlanViz — a standalone real-time AI plan visualizer

> **Status: design/plan document.** PlanViz is a standalone project, unrelated to the codebase
> hosting this file — it is parked here temporarily and will move to its own repository; this
> folder (`planviz/`) is fully self-contained so extraction is a single `git mv`.

## Context

A **generic, standalone app** that visualizes plans produced by AI coding agents (any harness —
Claude Code, Codex, Cursor, custom loops) **in real time**: watch the plan render as the agent
creates it, see the architecture it's building, and interact with the plan (annotate / edit /
approve parts) with that feedback flowing back to the agent.

## Prior art (researched 2026-07)

- **Claude Code–specific, read-only viewers** (closest neighbors, single-harness):
  [cc-plan-viewer](https://github.com/tomohiro-owada/cc-plan-viewer) (live `~/.claude/todos/`
  watcher), [claude-plan-viewer](https://github.com/HelgeSverre/claude-plan-viewer) and
  [claude-plan-visualizer](https://github.com/felipeorlando/claude-plan-visualizer) (plan-doc
  browsers), [claude-code-viewer](https://github.com/d-kimuson/claude-code-viewer) /
  [claudecodeui](https://github.com/siteboon/claudecodeui) (full session UIs),
  [visualplanner](https://github.com/ethanplusai/visualplanner) (one-shot plan→HTML skill).
- **Visual orchestrators** (kanban over sessions, not plan rendering): Vibe Kanban, nimbalyst.
- **Trace-first observability** (OTel/SDK-coupled, not plan-first, not interactive):
  [Langfuse agent graphs](https://langfuse.com/docs/observability/features/agent-graphs),
  LangGraph Studio, AgentOps,
  [AgentPrism](https://evilmartians.com/chronicles/debug-ai-fast-agent-prism-open-source-library-visualize-agent-traces).
- **MCP-side**: [mcp-cli `--dashboard`](https://mcpservers.org/servers/chrishayuk/mcp-cli)
  (DAG plan view, tied to that CLI), [MCP Apps](https://azurewithaj.com/mcp-apps/)
  (interactive HTML inside the chat client, not a standalone canvas).

**Gap PlanViz fills:** harness-agnostic *plan-first* protocol + live rendering + bidirectional
feedback to the agent + agent-pushed embedded HTML artifacts — no existing tool combines these.

## Core design

**One protocol, many transports.** The heart of the product is a tiny open **Plan Event
Protocol (PEP)**: an append-only stream of JSON events describing a plan document. Everything
else is an adapter.

- **Event envelope**: `{ v, planId, seq, ts, source, event }` — Zod-validated, fail-closed
  (unknown/corrupt lines are surfaced as warnings, never crash the viewer).
- **Event taxonomy** (discriminated union on `type`):
  - Plan structure: `plan_created`, `node_added` (phase/step/task, parent, title, detail),
    `node_updated`, `node_status` (`pending|active|done|failed|skipped`), `node_moved`,
    `dep_added` (node→node dependency)
  - Architecture: `component_added`, `component_updated`, `relation_added` (component→component,
    typed: uses/creates/modifies) — same stream, separate view
  - Activity: `activity` (agent turn / tool call / note, attached to a node) — powers the timeline
  - Rich content: `artifact_added` / `artifact_updated` — an agent attaches a **self-contained
    visualization** to the plan or to a node: `{ nodeId?, title, mime: 'text/html' | 'image/svg+xml'
    | 'text/markdown', content (inline) | path (file in the watched dir) }`. Agents are great at
    emitting static HTML (mermaid, charts, mock UIs, dashboards) — this makes those first-class.
    The app renders HTML artifacts **sandboxed** (iframe `srcdoc`, `sandbox` attr — scripts allowed
    but no network/top-navigation/forms by default) in the node detail panel and an artifact gallery.
  - Feedback (user → agent): `comment`, `edit_request`, `approval` (`approve|veto`) — each with
    its own `feedbackId` and lifecycle state — plus agent-side `feedback_ack { feedbackId,
    response? }` to close the loop (`open → acknowledged → resolved/declined`).
- **State = pure fold.** A reducer folds events into `PlanState` (tree + graph + timeline).
  Append-only + pure fold gives history scrubbing / time-travel for free later.

**Transports (staged):**
1. **Watched folder** (v1, universal): the app tails `<dir>/.planviz/*.jsonl`. Anything that can
   write a file can feed it — an agent hook, a wrapper script, `planviz emit` CLI.
2. **MCP server** (v2, rich + bidirectional): tools like `plan_open`, `plan_add_nodes`,
   `plan_set_status`, `plan_get_feedback`. Agents push directly; feedback returns via tool
   results. Uses `@modelcontextprotocol/sdk`.
3. **HTTP POST** (v2, trivial fallback): `POST /api/plans/:id/events` for CI/scripts.

**App shape:** local-first Node server (ingest adapters → reducer → SSE broadcast) + browser SPA
(live plan tree, event timeline, detail panel; later architecture graph + history scrubber +
feedback UI).

**How feedback reaches the agent** (same protocol, reverse direction). A UI action (comment on a
node, edit request, approve/veto) appends a feedback event to
`<dir>/.planviz/<planId>/feedback.jsonl`. Delivery per transport:
- *Folder transport (v1), pull*: `planviz feedback --pending <planId>` reads `feedback.jsonl`
  past a cursor and prints unaddressed items. A harness hook injects that into the agent's
  context between turns (e.g. a Claude Code Stop/prompt-submit hook returning it as additional
  context); any other harness gets one prompt line: "before each step, run `planviz feedback`
  and incorporate it".
- *MCP transport (v2), push-back*: every `plan_*` tool result carries `pendingFeedback: [...]`
  so the agent sees new feedback on its next plan touch without polling; plus an explicit
  `plan_get_feedback` tool and a **blocking `plan_await_approval(nodeId)`** for human-in-the-loop
  gates (agent pauses until the user clicks approve/veto in the UI, with timeout).
- *Closing the loop*: the agent emits `feedback_ack` (+ the actual plan edits); the UI threads
  the user's item with the agent's response and resulting change, and keeps unaddressed
  feedback highlighted.

## First implementation milestone (v0 prototype)

All inside `planviz/`, fully self-contained (own `package.json`, no imports from the host repo):

1. **`planviz/DESIGN.md`** — the polished concept doc: vision & positioning vs. prior art, the
   PEP spec (envelope, full event taxonomy with examples), transport designs (folder/MCP/HTTP),
   feedback-loop design, described UI wireframes (plan tree / timeline / architecture view),
   and a phased roadmap (M0 scaffold → M1 folder-watch + tree → M2 MCP + Claude Code hook
   adapter → M3 interaction → M4 architecture view + time-travel).
2. **`planviz/protocol/`** — `schema.ts` (Zod: envelope + event union + `PlanState`),
   `reducer.ts` (pure fold), with vitest unit tests (ordering, unknown-event tolerance,
   status transitions, torn-line tolerance at the read layer).
3. **`planviz/server/`** — minimal Node/TS server: JSONL tailer for a watched dir (poll-based
   tail, byte-offset resume, partial-line buffering), `GET /` (UI), `GET /api/plans`,
   `GET /api/plans/:id/events` (SSE: snapshot then live deltas).
4. **`planviz/ui/`** — single-page app (kept dependency-light: TS + a small view layer, no heavy
   framework build if avoidable): live plan tree with statuses/progress, live event feed,
   node detail panel **including sandboxed artifact rendering** (HTML via `iframe srcdoc` with a
   restrictive `sandbox` attribute, SVG/markdown inline). Auto-reconnecting SSE client.
5. **`planviz/demo/`** — `emit-demo.ts`: simulates an agent authoring and executing a plan
   (staggered events, **including an embedded HTML artifact** — e.g. an architecture sketch) so
   the live rendering is demonstrable without any real agent.
6. **Minimal feedback slice** — a comment box on a node in the UI appends a `comment` event to
   `feedback.jsonl` via `POST /api/plans/:id/feedback`, and `planviz feedback --pending <planId>`
   prints unaddressed items — proving the round-trip channel end-to-end (hook/MCP delivery stays
   on the roadmap).
7. **`planviz/README.md`** — quickstart: `npm i && npm run dev`, run the demo emitter, open the
   browser, watch the plan build itself.

Scaffolding: own `package.json` (ESM, Node ≥20, deps: `zod`; dev: `typescript`, `tsx`,
`vitest`), `tsconfig.json`, npm scripts (`dev`, `demo`, `test`, `typecheck`).

Out of scope for v0 (designed in DESIGN.md, not built): MCP server, Claude Code hook adapter,
architecture graph rendering, interactive editing UI beyond comments, history scrubber.

## Verification (for the v0 milestone)

- `npm run typecheck` and `npm test` clean inside `planviz/`.
- End-to-end: start the server pointing at a temp dir, run `npm run demo` to emit events,
  open the UI and confirm the tree renders and updates live; confirm SSE reconnect and
  mid-write partial lines don't break rendering.
