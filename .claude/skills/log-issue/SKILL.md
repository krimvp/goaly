---
name: log-issue
description: >-
  File a high-quality, verified GitHub issue for goaly using the matching template. Classifies the
  report (bug / feature / enhancement / harness adapter / discussion). For BUGS it enforces
  reported → replicated → logged: the bug is reproduced before it is filed, and the report carries
  verified reproduction steps plus a preliminary cause. For features/enhancements it captures a
  comprehensive, mission-and-invariant-aware proposal. Use when the user wants to report a bug,
  request a feature, propose an enhancement, request a harness, or open a discussion for this repo.
---

# Log an issue for goaly

Produce a GitHub issue that a maintainer (or the `work-on-issue` skill) can act on without
round-trips. The structure comes from the templates in
[`.github/ISSUE_TEMPLATE/`](../../../.github/ISSUE_TEMPLATE); this skill owns the **process** that
fills them — especially the *verify-before-you-log* loop for bugs.

## Step 0 — classify

Pick the type; if the report is ambiguous, ask one clarifying question before proceeding.

| Type | Template | Labels |
| --- | --- | --- |
| Reproducible defect | `bug_report.md` | `bug` |
| New capability | `feature_request.md` | `feature` |
| Improve existing behavior | `enhancement.md` | `enhancement` |
| Support a new harness | `harness_adapter.md` | `enhancement`, `harness` |
| Direction / decision | `discussion.md` | `question` |

Then **search for duplicates** before writing: `gh issue list --state all --search "<keywords>"`.
If one exists, comment there instead of opening a new issue.

## Bugs: reported → replicated → logged (do not skip)

A bug is filed **only after it is reproduced**. The three states:

1. **Reported.** Capture the user's explanation, the exact `goaly` invocation, and the environment
   (goaly/Node version, OS, harness, llm-provider/models).
2. **Replicated.** Reproduce it yourself, minimally and deterministically.
   - Prefer the **`fake` harness** with `--verify-cmd "true"`/`"false"` and `--autonomous` when the
     bug is in the orchestration layer — it reproduces with **zero network/API** and no real agent.
     Reach for a real harness only when the bug is in an adapter/LLM seam.
   - Work in a **throwaway dir** (`mktemp -d`, `git init`, one commit) or a copy — never reproduce
     destructively against the user's real workspace. **Redact** secrets and session ids.
   - Record what you actually observed: output, exit code (`0` DONE / `1` FAILED|ABORTED / `2` usage),
     stack trace, and the relevant lines of `.goaly/<runId>/`.
   - **If you cannot reproduce it:** do **not** file a bug. Report what you tried, ask for the missing
     detail (version, exact command, a minimal repro), or — if it's really a usage question — file it
     as a `discussion`/`question` instead. An unreproducible bug is not ready to log.
3. **Logged.** Fill `bug_report.md` with the **verified** reproduction steps and a **preliminary
   cause**: the suspected seam (harness / verifier ladder / approver / clock+budget), file
   (e.g. `src/orchestrator/decide.ts`), or parse/fail-closed path, and whether an invariant looks
   violated (see [`AGENTS.md`](../../../AGENTS.md) → the eight invariants). Don't fix it here — that's
   `work-on-issue`.

## Features / enhancements: make it comprehensive

Capture enough that the direction can be judged (the *decision to build* happens in `work-on-issue`,
but a vague request can't be judged at all). Fill the matching template end-to-end:

- **Feature** (new capability) → `feature_request.md`: problem/motivation, the concrete proposed
  capability (sketch the CLI flags or the embeddable signature), why it fits the harness-agnostic /
  frozen-contract mission, **invariant impact** (how each touched invariant is preserved),
  alternatives, acceptance criteria (tests + docs sync), out-of-scope, open questions.
- **Enhancement** (improve existing) → `enhancement.md`: precise current behavior (with file/flag
  refs), desired behavior, value, affected seam(s), invariant impact, acceptance criteria.

Be honest about open questions and whether the idea pulls against the mission — flag it rather than
oversell. A well-scoped "this might be declined because …" note is valuable.

## Harness / discussion

- **Harness** → `harness_adapter.md`. Run the **`investigate-harness`** skill first and paste its
  discovery worksheet (field/flag/status mapping) into the issue; redact session ids.
- **Discussion / decision** → `discussion.md`: context, real options with trade-offs, constraints
  (invariants, threat model, cross-platform), decision criteria, and the proposed deliverable
  (usually an ADR under `docs/adr/`).

## Create the issue

1. Read the chosen template under `.github/ISSUE_TEMPLATE/`, **drop the YAML frontmatter and the
   `<!-- -->` guidance comments**, and fill every section.
2. Write the filled body to a temp file and create it with the template's labels:

   ```bash
   gh issue create --title "<type>: <summary>" --label "<labels>" --body-file <tmpfile>
   ```

3. Report the issue URL back to the user. For bugs, state plainly that you reproduced it and how.

## Guardrails

- Never file a bug you couldn't reproduce; never run a reproduction destructively against the user's
  real repo; never paste secrets or un-redacted session ids.
- Match the repo's vocabulary (frozen contract, verifier ladder, seams, two-key DONE) — issues that
  use the right terms are faster to triage.
- One issue = one concern. Split multi-part reports.
