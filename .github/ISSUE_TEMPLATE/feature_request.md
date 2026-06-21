---
name: ✨ Feature request
about: Propose a new capability for goaly
title: "feat: <short summary>"
labels: feature
---

<!--
A "feature" is a NEW capability (use "Enhancement" to improve something that already exists).
Direction matters more than effort here: goaly is a deterministic, harness-agnostic
goal-orchestration layer with a frozen success contract. A feature that pulls against that mission
may be intentionally declined. Make the case.
-->

## Problem / motivation

<!-- What can't be done today, and who is blocked by it? Describe the need, not the solution. -->

## Proposed capability

<!-- What the feature does from the user's point of view: new CLI flags/subcommands, new embeddable
     API, new behavior. Be concrete — sketch the command line or the function signature. -->

## Why it belongs in goaly

<!-- How it fits the mission (harness-agnostic orchestration, frozen contract, anti-reward-hacking).
     If it's harness-specific, say which. -->

## Invariant impact

<!-- The eight invariants are the product. State how this preserves each one it touches:
     - Zero-LLM pure reducer (no IO/Promise/LLM in src/orchestrator/)
     - Compile once, then freeze (no transition rewrites the contract)
     - Two keys for DONE (frozen verifier ladder passes AND approver doesn't veto)
     - Fail-closed everywhere (errors → FAIL/VETO/crashed, never a green, never an unhandled throw)
     - --autonomous moves Gate A only
     - Parse at every seam (Zod), branded ids
     - Write-ahead + resume
     - Stuck detection stays pure
     If it touches none, say so. -->

## Alternatives considered

## Acceptance criteria / definition of done

<!-- What "done" looks like. Include: tests that pin the new behavior so it can't regress;
     `npm run typecheck` clean + `npm test` green; and docs synced if this changes the architecture,
     public/embeddable API, or user-facing functionality (README.md AND docs/index.html, plus
     docs/adding-a-harness.md if the harness-authoring pattern changes). -->

- [ ]
- [ ] New behavior covered by tests
- [ ] Docs synced (README.md + docs/index.html) if applicable

## Out of scope

## Open questions
