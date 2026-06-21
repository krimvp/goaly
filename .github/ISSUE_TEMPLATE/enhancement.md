---
name: 🔧 Enhancement
about: Improve an existing goaly behavior, ergonomics, or developer experience
title: "enhance: <short summary>"
labels: enhancement
---

<!--
An "enhancement" improves something that ALREADY exists (use "Feature request" for a brand-new
capability). Point at the current behavior precisely so the improvement is unambiguous.
-->

## Current behavior

<!-- What exists today, with file/flag references where possible
     (e.g. "the verifier ladder in src/verify/ladder.ts short-circuits on the first deterministic
     fail" or "--max-gate-a-revisions defaults to 10"). -->

## Desired behavior

<!-- The improvement, concretely. What changes from the user's / developer's point of view? -->

## Why

<!-- The value, and who benefits. -->

## Scope / affected areas

<!-- Which seam(s) or module(s): orchestrator, driver, verify, compile, harness, workspace, runlog,
     llm, cli. Keep the change focused. -->

## Invariant impact

<!-- State how the change preserves each invariant it touches (see AGENTS.md → "The eight
     invariants"). If it touches none, say so. -->

## Acceptance criteria / definition of done

- [ ] Behavior change covered by tests (so it can't silently regress)
- [ ] `npm run typecheck` clean + `npm test` green
- [ ] Docs synced (README.md + docs/index.html) if the change alters architecture / public API /
      user-facing functionality

## Open questions
