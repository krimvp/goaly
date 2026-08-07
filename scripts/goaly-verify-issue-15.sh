#!/usr/bin/env bash
# Verification for goaly issue #15: config-file support + configurable per-step timeouts, so the
# SAME run wiring does not have to be repeated on the CLI every time. Proves goaly reads run
# defaults from a config file AND that the per-step timeout flags actually bound a real subprocess.
#
# Exits 0 only when:
#   1. typecheck is clean and the full test suite is green (repo definition-of-done),
#   2. the standalone CLI builds,
#   3. a real `goaly run` with ONLY --goal picks up harness/autonomous/max-iterations/verify-cmd
#      from an implicit .goalyrc (smoke A),
#   4. an explicit `--config <path>` JSON file overrides .goalyrc (smoke B),
#   5. --verify-timeout-ms kills a hung verify command instead of stalling the loop (smoke C),
#   6. the feature is documented in README.md and the landing page (docs/index.html).
set -uo pipefail

# Repo root: prefer the script's own location, fall back to cwd (goaly runs verify in the workspace).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
[ -f "$REPO/package.json" ] || REPO="$(pwd)"
cd "$REPO" || { echo "FAIL: cannot cd to repo root" >&2; exit 1; }

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== typecheck (must be clean) =="
npm run --silent typecheck || fail "typecheck is not clean"

echo "== test suite (must be green) =="
npm test --silent || fail "test suite is not green"

echo "== build standalone CLI =="
npm run --silent build || fail "build failed"
test -f "$REPO/dist/goaly.js" || fail "build did not produce dist/goaly.js"

# A throwaway git repo, returned via stdout so each smoke runs in isolation.
new_sandbox() {
  local sandbox; sandbox="$(mktemp -d)" || return 1
  (
    cd "$sandbox" || exit 1
    git init -q
    git config user.email smoke@goaly.test
    git config user.name "goaly smoke"
    printf 'seed\n' > seed.txt
    git add -A && git commit -q -m init
  )
  printf '%s' "$sandbox"
}

# --- smoke A: implicit .goalyrc -------------------------------------------------------------------
# The .goalyrc's verify-cmd writes a uniquely-named marker then exits non-zero, so the deterministic
# verifier FAILS and the run never reaches the Gate-B approver -> no LLM / network needed. The marker
# can ONLY appear if goaly loaded verify-cmd from the file (it is NEVER passed as a flag; only --goal
# is). harness/autonomous must also come from the file or the run could not reach the verifier.
echo "== smoke A: only --goal on the CLI; wiring comes from an implicit .goalyrc =="
sandbox="$(new_sandbox)" || fail "could not create sandbox"
marker="$sandbox/goaly-rc.marker"
(
  cd "$sandbox" || exit 1
  printf '{ "harness": "fake", "autonomous": true, "max-iterations": 1, "verify-cmd": "touch %s; exit 7" }' "$marker" > .goalyrc
  timeout 240 node "$REPO/dist/goaly.js" run \
    --goal "smoke: prove .goalyrc is read without repeating flags" \
    </dev/null > goaly.out 2>&1 || true
)
test -f "$marker" || { rm -rf "$sandbox"; fail "smoke A: .goalyrc verify-cmd did not run (config not read)"; }
rm -rf "$sandbox"
echo "PASS: goaly ran the .goalyrc verify-cmd with no wiring flags."

# --- smoke B: explicit --config <path> overrides .goalyrc -----------------------------------------
# .goalyrc points verify-cmd at marker-A (exit 0 would let the run continue), but an explicit
# --config file overrides verify-cmd to write marker-B then exit non-zero. Only marker-B must exist.
echo "== smoke B: --config <path> overrides the implicit .goalyrc =="
sandbox="$(new_sandbox)" || fail "could not create sandbox"
marker_a="$sandbox/goaly-rc-A.marker"
marker_b="$sandbox/goaly-config-B.marker"
(
  cd "$sandbox" || exit 1
  printf '{ "harness": "fake", "autonomous": true, "max-iterations": 1, "verify-cmd": "touch %s; exit 7" }' "$marker_a" > .goalyrc
  printf '{ "verify-cmd": "touch %s; exit 7" }' "$marker_b" > explicit.json
  timeout 240 node "$REPO/dist/goaly.js" run \
    --goal "smoke: prove --config overrides .goalyrc" \
    --config explicit.json \
    </dev/null > goaly.out 2>&1 || true
)
test -f "$marker_b" || { rm -rf "$sandbox"; fail "smoke B: --config verify-cmd did not run (override failed)"; }
test -f "$marker_a" && { rm -rf "$sandbox"; fail "smoke B: .goalyrc verify-cmd ran -- --config did NOT override it"; }
rm -rf "$sandbox"
echo "PASS: --config verify-cmd ran and the .goalyrc value was overridden."

# --- smoke C: --verify-timeout-ms bounds a hung verify command ------------------------------------
# The verify-cmd sleeps far longer than the timeout. With --verify-timeout-ms small, goaly must
# SIGKILL it and finish promptly (a fail-closed FAIL), NOT stall for the full sleep.
echo "== smoke C: --verify-timeout-ms kills a hung verify command =="
sandbox="$(new_sandbox)" || fail "could not create sandbox"
(
  cd "$sandbox" || exit 1
  printf '{ "harness": "fake", "autonomous": true, "max-iterations": 1, "verify-cmd": "sleep 60" }' > .goalyrc
)
start=$(date +%s)
( cd "$sandbox" && timeout 60 node "$REPO/dist/goaly.js" run \
    --goal "smoke: prove --verify-timeout-ms bounds a hung verify" \
    --verify-timeout-ms 1500 \
    </dev/null > goaly.out 2>&1 || true )
elapsed=$(( $(date +%s) - start ))
rm -rf "$sandbox"
[ "$elapsed" -lt 30 ] || fail "smoke C: run took ${elapsed}s -- the verify timeout did not bound the hung command"
echo "PASS: a 60s verify-cmd was bounded by --verify-timeout-ms (run finished in ${elapsed}s)."

# --- docs -----------------------------------------------------------------------------------------
echo "== docs document .goalyrc, --config and the timeout flags =="
for token in ".goalyrc" "--config" "--verify-timeout-ms"; do
  grep -qF -- "$token" "$REPO/README.md" || fail "README.md does not mention '$token'"
done
grep -qF -- ".goalyrc" "$REPO/docs/index.html" || fail "docs/index.html does not mention '.goalyrc'"
grep -qF -- "verify-timeout-ms" "$REPO/docs/index.html" || fail "docs/index.html does not mention the timeout flags"

echo "OK: issue #15 satisfied -- config-file values + per-step timeouts are loaded, used, and documented."
exit 0
