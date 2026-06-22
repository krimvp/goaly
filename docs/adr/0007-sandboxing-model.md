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
macOS `sandbox-exec` launcher and a `firejail` fallback remain follow-ups. Network-egress
*allowlisting* (then a follow-up) is now **implemented** — see "Network-egress allowlist" below.

## Network-egress allowlist (issue #39, implemented)
The binary `--sandbox-net none|allow` toggle is extended with a third form,
`--sandbox-net allow:<host,…>`: an explicit allowlist of reachable hosts. Each host may be a bare
hostname (`api.anthropic.com`), a subdomain wildcard (`*.npmjs.org` — matches the base domain and
any subdomain), and may pin a port (`host:443`). The allowlist parses at the CLI seam (an
`AllowlistHost` regex, `min(1)` entries, invariant #6); an empty list or malformed host is a usage
error, never a silent fallback.

Semantics: with an allowlist the network stays **up** but is routed through a small allowlisting
egress proxy goaly starts on the host (loopback). Only the listed hosts are reachable; all other
egress is **denied** (HTTP 403 / refused CONNECT). Denied attempts are recorded and a summary is
logged after the run (`sandbox egress denied`) for an audit trail. Unlike `allow` (which keeps the
harness on full egress for the model API and only opens the verifier), an allowlist constrains
**both** seams — the harness *and* the verifier — so the harness's model-API host must itself be on
the list. The point (per the issue): `npm test` can reach the registry without *also* opening the
unrestricted exfiltration egress that full `allow` does.

Enforcement is per launcher, via standard proxy env vars (`SandboxRunOpts` carries an optional
`proxy` field with the chosen loopback port):
- **bwrap**: keeps the host network (NOT `--unshare-net`) and sets `HTTP(S)_PROXY` / `ALL_PROXY`
  (and lowercase variants) + `NO_PROXY=localhost,127.0.0.1` via `--setenv`, pointing at
  `127.0.0.1:<proxyPort>`.
- **container** (docker/podman): keeps the bridge network, adds
  `--add-host goaly-host-gateway:host-gateway`, and sets the same proxy env vars (`-e NAME=…`)
  pointing at `goaly-host-gateway:<proxyPort>`.

Fail-closed (invariant #4): if the proxy can't start, or an allowlist is requested without a running
proxy, the run **errors** rather than running with unrestricted egress.

## Threat model (what `--sandbox` defends against, and what it does not)
Defends: secret exfiltration via the verifier/agent (FS + env + egress), host FS damage outside the
workspace, reading credentials in `$HOME`, network beaconing (when net is off).
Does NOT defend: a compromised model endpoint the agent is allowed to talk to, supply-chain code
pulled with network on, kernel/sandbox-escape 0-days, or anything when `--sandbox` is off (Option 1).

**Allowlist limitation (honest).** The `allow:<host,…>` allowlist is **proxy-based** egress
filtering: it depends on clients honouring the proxy env vars. It is a **strong guardrail and audit
trail** for cooperating tooling (the agent CLI, npm, pip, git-over-https), **not** an airtight
network jail against deliberately malicious native code that opens raw sockets bypassing the proxy
env. A hard kernel-level allowlist (a separate network namespace + nftables filtering) would close
that gap and remains **future work**; the proxy approach was chosen first because it works
identically across bwrap and containers (including rootless/macos) and yields the audit trail. It
is fail-closed: a proxy that can't start aborts the run rather than degrading to unrestricted egress.

## Consequences
- A real isolation option exists for untrusted repos without forcing it on trusting users.
- New optional dependency on a host mechanism (bwrap/docker/podman); absence is fail-closed, not a
  silent downgrade.
- Network/FS tensions (e.g. `npm test` needing the network) are surfaced as explicit policy toggles
  (`--sandbox-net`, now including a host allowlist), documented, not hidden.
- The pure reducer and the eight invariants are untouched; this is a Driver/effects concern.
