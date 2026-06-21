#!/usr/bin/env bash
#
# make-goaly-sandbox.sh <dir> — create a fresh, throwaway git repo for a goaly demo:
# a tiny module with a deliberate bug (sum() ignores its args), a failing `node --test`
# suite, and a one-line GOAL.md. goaly's job in the demo is to close that gap.
#
# Why these choices (see goaly-demo-recipe.md for the full rationale):
#   * It MUST be a git repo — goaly's GitWorkspace diff-hashes with `git add -A`/`write-tree`.
#   * `node --test` is deterministic and dependency-free (Node >= 18): buggy => exit 1, fixed => 0.
#   * GOAL.md keeps the recorded command line short (`--goal-file GOAL.md`).
#
# Put the sandbox under a codex-TRUSTED path (e.g. inside your usual workspace root) so the
# `codex` harness's `--full-auto` writable sandbox is allowed. Run goaly FROM INSIDE this dir.
#
# Usage:
#   bash make-goaly-sandbox.sh /path/to/sandbox
set -e

dir="${1:?usage: make-goaly-sandbox.sh <dir>}"
rm -rf "$dir"
mkdir -p "$dir"
cd "$dir"

cat > sum.mjs <<'JS'
// A tiny module with a deliberate bug: sum() ignores its arguments.
export function sum(a, b) {
  return 0;
}
JS

cat > sum.test.mjs <<'JS'
import test from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';

test('adds two small numbers', () => {
  assert.equal(sum(2, 3), 5);
});

test('adds two larger numbers', () => {
  assert.equal(sum(10, 20), 30);
});
JS

cat > GOAL.md <<'MD'
Make sum(a, b) in sum.mjs return the sum of its two arguments so `node --test` passes.
MD

git init -q
git -c user.email=demo@goaly -c user.name=demo add -A
git -c user.email=demo@goaly -c user.name=demo commit -qm "initial: buggy sum() + failing test"

echo "sandbox ready at $dir (buggy: node --test exits 1; fixed: exits 0)"
