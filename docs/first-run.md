# First run

Use an existing project with a test command. Goaly needs Node 20 or newer. Install it with
`npm i -g goaly`, or use `npm run dev --` from a clone after `npm install`. It uses Git by
default; use `--workspace-mode file` for a plain directory. A coding-agent CLI must be installed
for the harness you select. See [harness selection](reference.md#harnesses).

## Check the environment

From a clone of this repository:

```bash
npm install
npm run dev -- doctor
```

For the installed package, run `goaly doctor` instead. The doctor reports the available
harnesses and environment. See [onboarding](reference.md#onboarding-goaly-doctor--goaly-init).

## Preview the config

From the project you want to change, run:

```bash
goaly run --goal "make the parser handle empty input" \
  --verify-cmd "npm test" --harness codex --mode review --dry-run
```

Replace the goal, check command, and harness with values for your project. The dry run checks
the input and prints the resolved config. It does not run the worker or verifier. If you use
this repository's source CLI, run `npm run dev -- run ... --workspace /path/to/project` from
the goaly clone because `npm run` starts in that clone.

## Start the run

Remove `--dry-run` from the command. In review mode, inspect the contract at Seal before you
approve it. Goaly then runs the worker, checks the frozen contract, and requests Sign-off only
after the verifier ladder passes. A veto or a failed check becomes feedback for another turn.
See [how a run works](how-it-works.md) for this sequence.

The default mode auto-accepts Seal and uses large token and wall-time caps. Keep
`--mode review` for a first run if you want to inspect the bar before work starts. For exact
defaults and limits, use [autonomy profiles](reference.md#autonomy-profiles---mode).

## Inspect the result

```bash
goaly runs list
goaly runs show <run-id>
```

The run ID appears in the run output. A result of DONE means the frozen ladder passed and
Sign-off did not veto. Its strength depends on the check quality and model independence. Read
[inspection and resume](reference.md#inspecting-past-runs) for logs, transcripts, and recovery.

The `fake` harness is useful for pipeline checks but does not fake the compiler, judge, or
approver in a CLI run. Those LLM steps still need a working provider. For source-level checks
with injected fakes, use the [verification guide](verification.md).
