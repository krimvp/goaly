# goaly docs

One table to find the right document. Each row names one task and the one place to read for it.

| I want to… | Read this |
| --- | --- |
| Run goaly — flags, modes, defaults, guarantees | [`docs/reference.md`](reference.md). It has a table of contents at the top. |
| Get the short tour first | [`README.md`](../README.md) |
| Understand why it holds (the trust model) | [`docs/adr/`](adr/README.md) — start with [0001](adr/0001-wrapper-over-hooks.md), [0002](adr/0002-compile-once-then-freeze.md), [0003](adr/0003-two-key-approval.md) — and [`ARCHITECTURE.md`](../ARCHITECTURE.md) for how it is built. |
| Contribute a change | [`AGENTS.md`](../AGENTS.md): the eight invariants, the commands, the definition of done. |
| Wrap a new agent CLI as a harness | [`docs/adding-a-harness.md`](adding-a-harness.md) |
| Look up a term | [`CONTEXT.md`](../CONTEXT.md) (terse, for contributors) or the [reference glossary](reference.md#glossary) (plain language). |
| See what changed between versions | [`CHANGELOG.md`](../CHANGELOG.md) |
| Read the history of finished plans | [`docs/archive/`](archive/) — executed plans and the pre-implementation design, kept as records. |

## Layout

```
README.md                  the short tour
AGENTS.md                  contributor guide: invariants, commands, conventions
ARCHITECTURE.md            how the system is built
CONTEXT.md                 the ubiquitous-language glossary
CHANGELOG.md               what changed, per version
docs/
  README.md                this router
  reference.md             the complete practical reference
  adding-a-harness.md      the harness-authoring guide
  index.html               the GitHub Pages landing page
  adr/                     architecture decision records (0001–0020)
  archive/                 finished plans and the original design handoff
  assets/                  images for the landing page
```

`scripts/check-docs-sync.ts` (`npm run check:docs`) fails when a CLI flag is missing from the
reference, or when a top-level document is not linked from this file.
