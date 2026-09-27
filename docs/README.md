# goaly docs

Read one level at a time. Each page links to the next level and to the code that implements it.

| Step | Read | You will learn |
| --- | --- | --- |
| 1. Get the idea | [Project README](../README.md) | What goaly does and the shortest run command. |
| 2. Try it | [First run](first-run.md) | Check the environment, run goaly, and inspect the result. |
| 3. Follow the flow | [How it works](how-it-works.md) | What the contract, Seal, worker, verifier, Sign-off, and Driver do in order. |
| 4. Use more features | [Practical reference](reference.md) | Commands, flags, defaults, recovery, and the [CLI cookbook](reference.md#cli-cookbook). |
| 5. Check the claims | [Verification](verification.md) | Which source files enforce key claims and which commands test them. |
| 6. Change the design | [Architecture](../ARCHITECTURE.md), [decision index](adr/README.md), [contributor rules](../AGENTS.md) | The seams, the reasons for them, and the change gates. Start with [ADR 0001](adr/0001-wrapper-over-hooks.md), [0002](adr/0002-compile-once-then-freeze.md), and [0003](adr/0003-two-key-approval.md). |

## Go directly to a task

| I want to… | Read this |
| --- | --- |
| Look up one flag or mode | [Reference](reference.md) or `goaly help <topic>` |
| Look up a term | [Reference glossary](reference.md#glossary) for plain language; [CONTEXT.md](../CONTEXT.md) for contributor terms |
| Add an agent harness | [Harness guide](adding-a-harness.md) |
| See what changed | [CHANGELOG.md](../CHANGELOG.md) |
| Read old plans | [Plan archive](archive/) |
| View the project page | [Landing page](index.html) |

## Where each kind of fact lives

- The [README](../README.md) is the short tour. The [reference](reference.md) owns commands,
  options, defaults, and guarantees. Do not copy the full flag list into other pages.
- [How it works](how-it-works.md) explains the order of a run.
  [Architecture](../ARCHITECTURE.md) explains the modules. [ADRs](adr/README.md) record decisions.
- [Verification](verification.md) links each important claim to source and a repeatable check.
  [AGENTS.md](../AGENTS.md) defines the required checks for changes.

`npm run check:docs` checks that every CLI flag and config key appears in the reference and that
every top-level Markdown document appears in this router. It does not check prose or links.
