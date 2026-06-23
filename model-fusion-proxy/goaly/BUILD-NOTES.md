# How this was built — goaly, run as-is

This proxy was built **by [goaly](https://github.com/krimvp/goaly) itself**, driving the
`claude-code` harness in its standard goal-orchestration loop. No manual orchestration: a single
`goaly run` with `--generate --autonomous` authored a frozen verification contract, then looped
RUN_AGENT → verifier ladder → Gate B until both keys agreed.

## Invocation

```bash
goaly run \
  --goal-file goaly/GOAL.md \
  --intent-file goaly/INTENT.md \
  --rubric-file goaly/RUBRIC.md \
  --generate --autonomous \
  --harness claude-code --llm-provider claude \
  --max-iterations 8 \
  --harness-timeout-ms 1800000 --harness-idle-timeout-ms 300000 \
  --llm-timeout-ms 1500000 \
  --stream-transcript
```

The instruction files in this directory are the inputs:
- `GOAL.md` — the full system specification (the goal).
- `INTENT.md` — guidance to goaly's compiler on how to author an in-repo, runnable, network-free bar.
- `RUBRIC.md` — the success rubric the LLM-judge rung scores against.

## Outcome

| | |
|---|---|
| status | **DONE** (two keys: verifier ladder passed **and** Gate B approver did not veto) |
| iterations | 2 |
| contract hash | `a2f4689c27f1b691d4f2fed82d6a1c874ecb90bb3f0b4791006ca0a79c421901` |
| frozen rungs | `[0]` deterministic `vitest run`, `[1]` LLM judge (quorum 3, floor 0.66) |
| total spend | ~12.98M tokens (cache-dominated: ~12.45M cache-read) |

Loop trace:

```
contract compiled (compiler authored 6 verification files under test/proxy/)
gate A: approve (autonomous — frozen + logged)
iteration 1: agent ran (changed) → verifier pass=false  (suite not yet fully green)
iteration 2: agent ran (changed) → verifier pass=true (judge 0.93) → gate B veto=false → DONE
```

## Verification files

The files under `test/proxy/` were **authored by goaly's compiler** as the frozen bar (not by the
worker), and pinned by content hash during the run so the worker could not weaken them. They are
kept here as durable, runnable verification: `npm test` re-runs them.
