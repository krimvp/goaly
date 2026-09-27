# Verify the documentation

Use this page to check a claim against the implementation. Run commands from the goaly
repository root. The [reference](reference.md) owns the full behavior and flag definitions.

| Claim | Source of behavior | Focused check |
| --- | --- | --- |
| The contract is compiled once and its hash stays fixed after Seal. | [Contract schema](../src/domain/contract.ts), [state transitions](../src/orchestrator/step.ts) | `npx vitest run src/orchestrator/step.test.ts src/driver/driver.test.ts` |
| DONE needs a passing ladder and no Sign-off veto. Sign-off runs only after a pass. | [Decision table](../src/orchestrator/decide.ts), [verification transition](../src/orchestrator/step.ts) | `npx vitest run src/orchestrator/decide.test.ts src/orchestrator/step.test.ts` |
| A ladder error gives a failed verdict. | [Ladder](../src/verify/ladder.ts) | `npx vitest run src/verify/ladder.test.ts` |
| Prepare checks required tools and the frozen verifier before the first worker turn. A failing user setup is fatal; a failing authored setup gives recovery feedback. | [Prepare](../src/driver/prepare.ts), [preflight classifier](../src/driver/preflight-soundness.ts) | `npx vitest run src/driver/prepare.test.ts src/driver/preflight-soundness.test.ts` |
| The Driver writes each event before it advances the state. The file log validates records on read. | [Driver](../src/driver/driver.ts), [file run log](../src/runlog/file-runlog.ts) | `npx vitest run src/driver/driver.test.ts src/runlog/file-runlog.test.ts` |
| The built-in default preset supplies run limits when no mode or preset is chosen. | [Preset overlay](../src/cli/presets.ts), [argument resolution](../src/cli/args.ts) | `npx vitest run src/cli/presets.test.ts src/cli/args.test.ts` |
| CLI flags and config keys have reference entries. Each top-level document appears in this index. | [CLI help](../src/cli/help.ts), [docs check](../scripts/check-docs-sync.ts) | `npm run check:docs` |

These tests cover the stated paths. They do not prove that every possible goal or authored check
is sound. Read [the trust model](reference.md#the-trust-model) for the limits of a DONE result.

## Run the repository checks

```bash
npm install
npm run typecheck
npm test
npm run check:docs
```

`npm test` runs the full Vitest suite. `npm run check:docs` checks flag, config-key, and document
coverage. It does not test the meaning of prose or validate Markdown links.

On 2026-09-27, from source revision `647e525`, `npm run typecheck` passed; `npm test` passed
(195 test files, 2,627 tests passed, 1 skipped); and `npm run check:docs` passed (103 flags,
82 config keys, 10 docs routed after this documentation change). These are local results,
not a claim that future revisions pass.

## Check the CLI without starting a worker

The dry run checks CLI input and prints the resolved config. It does not run a coding agent or
the verifier. Use a temporary workspace to avoid adding run files to the repository:

```bash
work_dir=$(mktemp -d)
npm run dev -- run --goal "add a health endpoint" --verify-cmd "true" \
  --harness fake --workspace-mode file --workspace "$work_dir" --dry-run
```

The `fake` harness changes no files. In a CLI run, it does **not** fake the compiler, judge,
or approver. A live CLI run still needs a working LLM provider. The composition tests inject
fake implementations for those seams; see [the test fakes](../src/testing/fakes.ts) and
[composition tests](../src/cli/compose.test.ts). Do not treat a `fake` CLI run as a fully offline
proof of DONE.

For a live run, use a real harness and a meaningful verification command in a project workspace.
Then inspect the run with `goaly runs show <run-id>` or `goaly ui`. See the
[CLI cookbook](reference.md#cli-cookbook) and [inspection commands](reference.md#inspecting-past-runs).

The 2026-09-27 local run also exercised the fail-closed path. It used `--harness fake`,
`--verify-cmd "true"`, `--autonomous`, and `--llm-provider openai` with a closed local endpoint.
The contract froze, the fake worker ran, and the verifier passed. Sign-off could not reach the
endpoint, so it vetoed and the CLI exited 1. This checks the two-key failure path. It does not
show a successful model-backed Sign-off.
