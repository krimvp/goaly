#!/usr/bin/env bash
# Live smoke test for issue #9: opt-in --sandbox. Proves the jail ACTUALLY isolates (not just that
# argv is built right — that's the unit suite). It runs `goaly run --harness fake` so the agent makes
# no changes but the VERIFIER command still executes inside the real jail, writing observations to the
# rw-bound workspace. A planted FAKE secret under a throwaway $HOME is used so the real ~/.ssh is never
# touched. Each case asserts the security property; a final line prints PASS/FAIL totals (exit 0 iff all
# pass). Requires: a built dist/goaly.js, bubblewrap (`bwrap`), and a docker daemon for the container case.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
GOALY="${GOALY:-$REPO/dist/goaly.js}"
IMAGE="${SMOKE_IMAGE:-python:3.12-slim}" # cached locally; has python3 for the network probe
PASS=0; FAIL=0
ok()  { echo "  PASS: $*"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

command -v bwrap  >/dev/null || { echo "SKIP: bwrap not installed"; exit 2; }
test -f "$GOALY" || { echo "FAIL: no $GOALY — run 'npm run build'"; exit 1; }

# A throwaway $HOME carrying a planted secret (.ssh/id_fake) and a non-secret (visible.txt).
FAKEHOME="$(mktemp -d)"; trap 'rm -rf "$FAKEHOME"' EXIT
mkdir -p "$FAKEHOME/.ssh"
echo "FAKE_PRIVATE_KEY_MATERIAL" > "$FAKEHOME/.ssh/id_fake"
echo "not-a-secret"             > "$FAKEHOME/visible.txt"

# A fresh git workspace seeded with a probe that records what the jail allowed, to result.txt (cwd).
new_ws() {
  local ws; ws="$(mktemp -d)"
  ( cd "$ws" && git init -q && git config user.email s@s.t && git config user.name s \
      && echo seed > seed.txt && git add -A && git commit -qm init )
  cat > "$ws/probe.sh" <<'PROBE'
{
  echo "PWD=$(pwd)"
  if touch ws_write_test 2>/dev/null; then echo "WS_WRITE=yes"; rm -f ws_write_test; else echo "WS_WRITE=no"; fi
  echo "HOME=$HOME"
  echo "SSH_COUNT=$(ls -A "$HOME/.ssh" 2>/dev/null | wc -l | tr -d ' ')"
  if cat "$HOME/.ssh/id_fake" >/dev/null 2>&1; then echo "SECRET_READ=LEAKED"; else echo "SECRET_READ=masked"; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import socket
s = socket.socket(); s.settimeout(4)
try:
    s.connect(("8.8.8.8", 53)); print("NET=open")
except OSError:
    print("NET=blocked")
PY
  else
    echo "NET=unknown(no python3)"
  fi
} > result.txt 2>&1
PROBE
  printf '%s' "$ws"
}

# run_case <name> <ws> [extra goaly flags...] — runs goaly jailed, then echoes result.txt.
run_case() {
  local name="$1" ws="$2"; shift 2
  ( cd "$ws" && HOME="$FAKEHOME" node "$GOALY" run --goal smoke \
      --verify-cmd "sh probe.sh; exit 1" --harness fake --autonomous --max-iterations 1 \
      "$@" >"/tmp/goaly-smoke-$name.log" 2>&1 )
  echo "[$name] result.txt:"; sed 's/^/    /' "$ws/result.txt" 2>/dev/null || echo "    (no result.txt)"
}

has() { grep -q "$1" "$2" 2>/dev/null; }

echo "================ CASE 0: baseline (no --sandbox) — positive control ================"
WS="$(new_ws)"; run_case baseline "$WS"
R="$WS/result.txt"
has "NET=open"        "$R" && ok "baseline: network reachable (probe is meaningful)"        || bad "baseline: expected NET=open"
has "SECRET_READ=LEAKED" "$R" && ok "baseline: fake \$HOME/.ssh secret IS readable unsandboxed" || bad "baseline: expected SECRET_READ=LEAKED"

echo "================ CASE 1: --sandbox=bwrap --sandbox-net none ================"
WS="$(new_ws)"; run_case bwrap-none "$WS" --sandbox=bwrap --sandbox-net none
R="$WS/result.txt"
has "WS_WRITE=yes"      "$R" && ok "bwrap: workspace is writable inside the jail"        || bad "bwrap: workspace not writable"
has "SECRET_READ=masked" "$R" && ok "bwrap: \$HOME/.ssh secret is MASKED (cannot be read)" || bad "bwrap: secret leaked!"
has "SSH_COUNT=0"       "$R" && ok "bwrap: \$HOME/.ssh appears empty (tmpfs mask)"        || bad "bwrap: .ssh not masked"
has "NET=blocked"       "$R" && ok "bwrap: network egress is cut (--unshare-net)"        || bad "bwrap: network not blocked"

echo "================ CASE 2: --sandbox=bwrap --sandbox-net allow (toggle control) ================"
WS="$(new_ws)"; run_case bwrap-allow "$WS" --sandbox=bwrap --sandbox-net allow
R="$WS/result.txt"
has "NET=open"          "$R" && ok "bwrap: --sandbox-net allow restores egress (toggle works)" || bad "bwrap: allow did not restore net"
has "SECRET_READ=masked" "$R" && ok "bwrap: secret still masked even with net allowed"         || bad "bwrap: secret leaked with net allow"

if docker info >/dev/null 2>&1; then
  echo "================ CASE 3: --sandbox=container --sandbox-net none (image: $IMAGE) ================"
  WS="$(new_ws)"; run_case container-none "$WS" --sandbox=container --sandbox-net none --sandbox-image "$IMAGE"
  R="$WS/result.txt"
  has "WS_WRITE=yes"       "$R" && ok "container: workspace bind is writable inside the container"  || bad "container: workspace not writable"
  has "SECRET_READ=masked" "$R" && ok "container: host \$HOME is NOT mounted (secret unreachable)"  || bad "container: secret leaked!"
  has "NET=blocked"        "$R" && ok "container: --network none cuts egress"                       || bad "container: network not blocked"
else
  echo "SKIP CASE 3: docker daemon not available"
fi

echo "================ CASE 4: fail-closed — --sandbox=bwrap with bwrap hidden from PATH ================"
WS="$(new_ws)"
# node lives in /usr/bin alongside bwrap/docker, so we can't just drop /usr/bin. Build a minimal bin
# dir that contains ONLY a node symlink, and point PATH at it — bwrap/docker become undiscoverable.
ONLYNODE="$(mktemp -d)"; ln -s "$(command -v node)" "$ONLYNODE/node"
( cd "$WS" && HOME="$FAKEHOME" PATH="$ONLYNODE" "$ONLYNODE/node" "$GOALY" run --goal smoke \
    --verify-cmd "true" --harness fake --autonomous --max-iterations 1 --sandbox=bwrap \
    >"/tmp/goaly-smoke-failclosed.log" 2>&1 )
code=$?
rm -rf "$ONLYNODE"
if [ "$code" -ne 0 ] && grep -qi "refus\|unavailable" /tmp/goaly-smoke-failclosed.log; then
  ok "fail-closed: requested bwrap absent ⇒ run refused to start (exit $code), never ran unsandboxed"
else
  bad "fail-closed: expected non-zero exit + refusal (got exit $code)"; sed 's/^/    /' /tmp/goaly-smoke-failclosed.log
fi

echo "=========================================================="
echo "SANDBOX SMOKE: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN" || echo "FAILURES PRESENT"
exit "$FAIL"
