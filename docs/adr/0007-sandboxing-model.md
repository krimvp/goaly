# ADR 0007 — Sandboxing model: opt-in OS isolation, Option-1 default

## Status
Accepted.

## Context
goaly runs an untrusted coding agent that edits the workspace and executes user/model-authored
verifier commands every iteration — untrusted code generation AND untrusted command execution on the
host. In `--autonomous --generate` the verifier itself is fully model-authored. The host trust
boundary is real.

Today goaly mitigates but does not enforce isolation: the verify command runs with a
credential-scrubbed env (`scrubEnv`), path-traversal is guarded, subprocesses are time/output/group
bounded, and harness CLIs carry their own permission modes. There is no OS-level isolation and no
network-egress control. The agent and verifier legitimately need network (model API, packages),
which makes total isolation impractical as a default.

Three stances were considered: (1) assume the caller sandboxes (document it), (2) build sandboxing
in and make it mandatory, (3) opt-in sandbox with the documented assumption as default.

## Decision
**Option 3.** Ship an **opt-in** OS sandbox behind `--sandbox`, defaulting to **off** (Option 1):
without the flag, behavior is unchanged and the caller is responsible for isolation (CI/container).

The sandbox is a new injectable seam (`src/sandbox/`) wrapping the two untrusted-code execs — the
harness/agent CLI and the verifier `run()` — at the composition root. It never touches the pure
reducer (invariant #1) and is selected/parsed like any other flag (invariant #6). When `--sandbox`
is requested but no mechanism is available, the run **refuses to start** rather than silently running
unsandboxed (invariant #4, fail-closed).

Per-seam profiles: the harness gets rw-workspace + ro-system + network (model API) + full env (API
keys); the verifier gets rw-workspace + ro-system + no-network-by-default + the already-scrubbed env.
`$HOME` credential locations (`~/.ssh`, `~/.aws`, …) are denied in both. Git plumbing
(diff/diffHash) is NOT sandboxed — it must read the real `.git`.

First implementation (slice 1, shipped together): Linux `bwrap` (bubblewrap), a portable `container`
(docker/podman) launcher — which also covers macOS — and an identity `none` launcher. A native
macOS `sandbox-exec` launcher, a `firejail` fallback, and network-egress *allowlisting* are
follow-ups.

## Threat model (what `--sandbox` defends against, and what it does not)
Defends: secret exfiltration via the verifier/agent (FS + env + egress), host FS damage outside the
workspace, reading credentials in `$HOME`, network beaconing (when net is off).
Does NOT defend: a compromised model endpoint the agent is allowed to talk to, supply-chain code
pulled with network on, kernel/sandbox-escape 0-days, or anything when `--sandbox` is off (Option 1).

## Consequences
- A real isolation option exists for untrusted repos without forcing it on trusting users.
- New optional dependency on a host mechanism (bwrap/docker/podman); absence is fail-closed, not a
  silent downgrade.
- Network/FS tensions (e.g. `npm test` needing the network) are surfaced as explicit policy toggles
  (`--sandbox-net`), documented, not hidden.
- The pure reducer and the eight invariants are untouched; this is a Driver/effects concern.
