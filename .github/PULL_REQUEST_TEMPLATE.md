<!--
Keep diffs focused. A PR that touches the reducer (src/orchestrator/) MUST explain how purity and the
two-key invariant are preserved. See AGENTS.md → "Commits / PRs" and "The eight invariants".
-->

## What & why

<!-- What this change does and why. Link the issue it resolves. -->

Fixes #

## Type of change

- [ ] Bug fix
- [ ] Feature (new capability)
- [ ] Enhancement (improve existing behavior)
- [ ] Harness adapter
- [ ] Docs / chore / refactor

## Definition of done

- [ ] `npm run typecheck` clean
- [ ] `npm test` green
- [ ] New behavior covered by tests — a **bug fix ships with a regression test that reproduces the
      bug**; a **feature/enhancement ships with tests that pin the new behavior** so it can't regress
- [ ] None of the eight invariants weakened (a needed change adds a test, it doesn't relax an invariant)
- [ ] Docs synced **in this change** if it alters architecture / public-embeddable API / user-facing
      functionality: `README.md` **and** `docs/index.html` (plus `docs/adding-a-harness.md` if the
      harness-authoring pattern changed)

## Invariant impact

<!-- If this touches src/orchestrator/, the contract freeze, the verifier ladder, the two-key DONE,
     a seam, or a fail-closed/parse path: state how each affected invariant is preserved. Otherwise
     write "no invariant-bearing code touched". -->

## Demo

<!-- Optional. If this changes user-facing CLI output/behavior, a short terminal-demo GIF helps
     reviewers. The `record-demo-gif` skill records one (see .claude/skills/record-demo-gif/ and its
     goaly-demo-recipe.md). Host the GIF and embed it: ![demo](https://files.catbox.moe/...gif) —
     don't commit the GIF into the repo. -->

## Notes for reviewers
