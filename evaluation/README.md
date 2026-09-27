# Independent product evaluation

Run one bounded task:

```sh
npx tsx scripts/eval-product.ts --task order-pricing
```

Run both tasks with `--all`. Use `--output DIR` to select an evidence directory and `--model MODEL` to pin the Codex model. The runner creates a fresh temporary worker workspace for each task. It copies that workspace and its `.goaly` run log into the evidence directory after the run. The withheld checks stay in [`oracle.cjs`](oracle.cjs), outside the worker workspace. The worker sees only the seed files and the stated goal.

Each run has fixed limits: 2 iterations, 300,000 reported tokens, a 180 second Goaly wall budget, a 90 second harness call timeout, and a 200 second outer process timeout. A single harness call can exceed the token budget before Goaly receives its usage report. Check the token and wall-clock fields in the result.

The evidence directory contains `command.json`, captured Goaly and oracle output, `result.json`, and the full worker workspace with raw `.goaly` logs. The top-level `summary.json` records the terminal status, oracle outcome, classification, attempts, iterations, tokens, elapsed time, errors, model/provider, degraded mode, oracle SHA-256, and raw log path. Its metrics include Goaly completion rate, oracle pass rate over evaluable runs, and recovery rate for runs that had an in-loop verifier failure or Sign-off veto. A null recovery rate means no run had that opportunity.

The classifications compare Goaly's terminal status with the independent oracle: `false-done` means Goaly said DONE and the oracle failed; `false-red` means Goaly did not say DONE and the oracle passed. A missing oracle result or a run that ended before a worker iteration is `unresolved`. These two tasks are a smoke evaluation. One run per task does not estimate a success rate. A same-model Sign-off is recorded as `SELF-JUDGED` and does not show independent model agreement.
